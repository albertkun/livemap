// Shared heading-arrow support for vehicle markers (used by both the
// rail view (websocket.js) and the bus view (js/bus.js)).
//
// The GTFS-realtime feed frequently drops `position.bearing`: in the rail
// feed the field is simply absent, and in the bus feed it also arrives as
// a literal 0.0 sentinel (even on moving vehicles). Both cases must be
// treated as "no update" — otherwise the arrow snaps to north. When the
// reported bearing is unusable, the heading is derived from how far the
// vehicle actually moved; if it hasn't moved far enough to trust, the
// previous heading is kept. A vehicle genuinely travelling due north still
// gets a correct arrow via the movement fallback.
//
// The arrow lives in a child element of the marker and is rotated with its
// own CSS transform. Never rotate the marker root: MapLibre owns the root
// element's `transform` and rewrites it on every setLngLat/map move, which
// is why earlier attempts kept losing their rotation.
const VehicleHeading = (() => {
	const ARROW_URL = 'arrow.svg'; // resolved against the page URL; both pages live at the site root
	const MIN_MOVE_METERS = 20;    // below this, position deltas are GPS jitter, not travel
	const EARTH_RADIUS_M = 6371000;
	const FLIP_DEGREES = 100;      // a turn sharper than this is treated as a suspect flip
	const CONFIRM_DEGREES = 45;    // a repeated report within this range confirms a flip
	const STOPPED_SPEED = 1;       // m/s; below this the vehicle is considered stationary
	const STALE_SECONDS = 30;      // GPS fixes older than this can't be trusted for heading

	function ensureStyles() {
		if (document.getElementById('vehicle-heading-styles')) return;
		const style = document.createElement('style');
		style.id = 'vehicle-heading-styles';
		style.textContent = `
			.heading-ring {
				position: absolute;
				inset: 0;
				visibility: hidden;
				transition: transform 0.5s ease-out;
				pointer-events: none;
			}
			.heading-chip {
				position: absolute;
				left: 50%;
				top: 0;
				width: 85%;
				aspect-ratio: 1;
				transform: translate(-50%, -80%);
				background: url('${ARROW_URL}') no-repeat center / contain;
			}
			.heading-face {
				position: absolute;
				inset: 0;
				background: inherit;
				border-radius: inherit;
				pointer-events: none;
			}
		`;
		document.head.appendChild(style);
	}

	// Adds the (initially hidden) arrow to a marker element. The chip is the
	// same size as the marker and overlaps ("bleeds into") it; the face is a
	// copy of the marker's own background stacked above the ring, so the
	// overlapping part of the chip tucks behind the vehicle icon.
	function attach(markerEl) {
		ensureStyles();
		const ring = document.createElement('div');
		ring.className = 'heading-ring';
		const chip = document.createElement('div');
		chip.className = 'heading-chip';
		ring.appendChild(chip);
		markerEl.appendChild(ring);
		const face = document.createElement('div');
		face.className = 'heading-face';
		markerEl.appendChild(face);
	}

	// A usable bearing is a finite number other than the 0.0 "unknown"
	// sentinel the feed sends. Returns degrees in [0, 360) or null.
	function parseBearing(raw) {
		const b = typeof raw === 'string' ? parseFloat(raw) : raw;
		if (!Number.isFinite(b) || b === 0) return null;
		if (b > 0 && b < 360) return b;
		return ((b % 360) + 360) % 360;
	}

	function toLngLat(coords) {
		if (!coords) return null;
		if (Array.isArray(coords)) return { lng: coords[0], lat: coords[1] };
		return coords; // already {lng, lat}
	}

	function movedMeters(from, to) {
		const rad = Math.PI / 180;
		const dLat = (to.lat - from.lat) * rad;
		const dLng = (to.lng - from.lng) * rad * Math.cos(((from.lat + to.lat) / 2) * rad);
		return Math.sqrt(dLat * dLat + dLng * dLng) * EARTH_RADIUS_M;
	}

	function bearingBetween(from, to) {
		const rad = Math.PI / 180;
		const y = Math.sin((to.lng - from.lng) * rad) * Math.cos(to.lat * rad);
		const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) -
			Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lng - from.lng) * rad);
		return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
	}

	// Unsigned angular distance between two headings, in [0, 180].
	function angularDiff(a, b) {
		const d = Math.abs(a - b) % 360;
		return d > 180 ? 360 - d : d;
	}

	// Decides which heading to show and keeps it stable across flaky data.
	// `state` is the marker (uses state.lastHeading, state._pendingHeading).
	//
	// Sources, most trusted first:
	//   1. actual movement (>= MIN_MOVE_METERS) — a vehicle travels the way
	//      it moved, so this even overrules a conflicting reported bearing
	//      (rail cars report the car body's orientation, which stays fixed
	//      when the train reverses direction);
	//   2. the reported bearing;
	//   3. the previous heading (null if there has never been one).
	//
	// A sudden turn sharper than FLIP_DEGREES is never accepted from a single
	// update, no matter the source — GPS bounces can fake a reversed movement
	// just as reversed rail cars fake a flipped bearing. The turn is held
	// until the next update agrees with it (real reversals confirm within one
	// update; one-off glitches never do), and a reported-only flip is ignored
	// outright while the vehicle is stationary. This stops markers from
	// flip-flopping 180° on the spot.
	//
	// Two staleness escapes:
	//   - `timestamp` (feed GPS-fix time, epoch seconds): fixes older than
	//     STALE_SECONDS carry no usable heading — the previous heading is
	//     kept as-is (null for a new vehicle, so its arrow stays hidden
	//     rather than showing a stale guess);
	//   - a heading learned from a vehicle's very first message is marked
	//     provisional (state._provisionalHeading, set by the caller): there
	//     was no history to cross-check it, so the first fresh update may
	//     replace it outright instead of the flip rules defending it.
	function resolve(rawBearing, prevCoords, nextCoords, state, speed, timestamp) {
		const last0 = state && typeof state.lastHeading === 'number' ? state.lastHeading : null;
		const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;
		if (Number.isFinite(ts) && (Date.now() / 1000) - ts > STALE_SECONDS) {
			return last0;
		}

		const reported = parseBearing(rawBearing);
		const from = toLngLat(prevCoords);
		const to = toLngLat(nextCoords);
		const movement = (from && to && movedMeters(from, to) >= MIN_MOVE_METERS)
			? bearingBetween(from, to)
			: null;

		let candidate;
		let fromMovement = false;
		if (movement !== null && reported !== null) {
			fromMovement = angularDiff(reported, movement) > 90;
			candidate = fromMovement ? movement : reported;
		} else if (movement !== null) {
			candidate = movement;
			fromMovement = true;
		} else {
			candidate = reported; // may be null
		}

		const last = last0;
		if (candidate === null) return last;
		if (last === null || !state) return candidate;

		if (state._provisionalHeading) {
			// The current heading was never cross-checked against anything;
			// this first fresh candidate (movement-preferred) supersedes it.
			state._provisionalHeading = false;
			state._pendingHeading = null;
			return candidate;
		}

		if (angularDiff(candidate, last) <= FLIP_DEGREES) {
			state._pendingHeading = null;
			return candidate;
		}

		// Sharp turn: suspect until proven.
		const parsedSpeed = typeof speed === 'string' ? parseFloat(speed) : speed;
		if (!fromMovement && Number.isFinite(parsedSpeed) && parsedSpeed < STOPPED_SPEED) {
			// Stationary vehicles don't spin in place — keep the old heading.
			state._pendingHeading = null;
			return last;
		}
		if (typeof state._pendingHeading === 'number' &&
			angularDiff(candidate, state._pendingHeading) <= CONFIRM_DEGREES) {
			// Second consecutive update agrees: the turn is real.
			state._pendingHeading = null;
			return candidate;
		}
		state._pendingHeading = candidate;
		return last;
	}

	// Rotates a marker's arrow to `heading` (compass degrees), compensating
	// for the map's own bearing. The displayed angle accumulates by the
	// shortest signed delta so the CSS transition never spins the long way
	// around (e.g. 350° -> 10° turns 20°, not -340°). Large turns (accepted
	// reversals) and the arrow's first appearance snap into place instead of
	// visibly sweeping around the marker.
	function apply(marker, heading, mapBearing) {
		const ring = marker.getElement().querySelector('.heading-ring');
		if (!ring || typeof heading !== 'number') return;

		const target = heading - (mapBearing || 0);
		let snap = false;
		if (typeof marker._headingAngle !== 'number') {
			marker._headingAngle = target;
			snap = true;
		} else {
			let delta = (target - marker._headingAngle) % 360;
			if (delta > 180) delta -= 360;
			if (delta < -180) delta += 360;
			marker._headingAngle += delta;
			snap = Math.abs(delta) > FLIP_DEGREES;
		}
		if (snap) {
			ring.style.transition = 'none';
			ring.style.transform = `rotate(${marker._headingAngle}deg)`;
			// Flush the un-transitioned state before restoring the transition
			if (typeof ring.offsetWidth === 'number') void ring.offsetWidth;
			ring.style.transition = '';
		} else {
			ring.style.transform = `rotate(${marker._headingAngle}deg)`;
		}
		ring.style.visibility = 'visible';
	}

	// Re-applies every marker's stored heading, e.g. after the map rotates.
	function refreshAll(markers, mapBearing) {
		for (const id in markers) {
			const marker = markers[id];
			if (typeof marker.lastHeading === 'number') {
				apply(marker, marker.lastHeading, mapBearing);
			}
		}
	}

	return { attach, resolve, apply, refreshAll };
})();
