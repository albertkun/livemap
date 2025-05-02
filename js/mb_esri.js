(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = global || self, factory(global.mapboxglEsriSources = {}));
}(this, (function (exports) { 'use strict';

    function cleanTrailingSlash (url) {
        return url.replace(/\/$/, '')
    }

    function getServiceDetails (url, fetchOptions = {}) {
        return new Promise((resolve, reject) => {
            fetch(`${url}?f=json`, fetchOptions)
                .then(response => response.json())
                .then(data => resolve(data))
                .catch(error => reject(error));
        })
    }

    const POWERED_BY_ESRI_ATTRIBUTION_STRING = 'Powered by <a href="https://www.esri.com">Esri</a>';
    // This requires hooking into some undocumented properties
    function updateAttribution (newAttribution, sourceId, map) {
        const attributionController = map._controls.find(c => '_attribHTML' in c);
        if (!attributionController) return

        const customAttribution = attributionController.options.customAttribution;

        if (typeof customAttribution === 'string') {
            attributionController.options.customAttribution = `${customAttribution} | ${POWERED_BY_ESRI_ATTRIBUTION_STRING}`;
        } else if (customAttribution === undefined) {
            attributionController.options.customAttribution = POWERED_BY_ESRI_ATTRIBUTION_STRING;
        } else if (Array.isArray(customAttribution)) {
            if (customAttribution.indexOf(POWERED_BY_ESRI_ATTRIBUTION_STRING) === -1) {
                customAttribution.push(POWERED_BY_ESRI_ATTRIBUTION_STRING);
            }
        }

        if (map.style.sourceCaches) {
            map.style.sourceCaches[sourceId]._source.attribution = newAttribution;
        } else if (map.style._otherSourceCaches) {
            map.style._otherSourceCaches[sourceId]._source.attribution = newAttribution;
        }
        attributionController._updateAttributions();
    }

    class DynamicMapService {

        constructor (sourceId, map, esriServiceOptions, rasterSrcOptions) {
            if (!esriServiceOptions.url) throw new Error('A url must be supplied as part of the esriServiceOptions object.')

            esriServiceOptions.url = cleanTrailingSlash(esriServiceOptions.url);

            this._sourceId = sourceId;
            this._map = map;

            this._defaultEsriOptions = {
                layers: false,
                layerDefs: false,
                format: 'png24',
                dpi: 96,
                transparent: true,
                getAttributionFromService: true
            };

            this.rasterSrcOptions = rasterSrcOptions;
            this.esriServiceOptions = esriServiceOptions;
            this._createSource();

            this._serviceMetadata = null;

            if (this.options.getAttributionFromService) this.setAttributionFromService();
        }

        get options () {
            return {
                ...this._defaultEsriOptions,
                ...this.esriServiceOptions
            }
        }

        get _layersStr () {
            let lyrs = this.options.layers;
            if (!lyrs) return false
            if (!Array.isArray(lyrs)) lyrs = [lyrs];
            return `show:${lyrs.join(',')}`
        }

        get _layerDefs () {
            if (this.options.layerDefs !== false) return JSON.stringify(this.options.layerDefs)
            return false
        }

        get _time () {
            if (!this.options.to) return false
            let from = this.options.from;
            let to = this.options.to;
            if (from instanceof Date) from = from.valueOf();
            if (to instanceof Date) to = to.valueOf();

            return `${from},${to}`
        }

        get _source () {
            const tileSize = this.rasterSrcOptions ? this.rasterSrcOptions.tileSize ? this.rasterSrcOptions.tileSize : 256 : 256;
            // These are the bare minimum parameters
            const params = new URLSearchParams({
                bboxSR: 3857,
                imageSR: 3857,
                format: this.options.format,
                layers: this._layersStr,
                transparent: this.options.transparent,
                size: [tileSize, tileSize],
                f: 'image'
            });

            // These are optional params
            if (this._time) params.append('time', this._time);
            if (this._layerDefs) params.append('layerDefs', this._layerDefs);

            return {
                type: 'raster',
                tiles: [
                    `${this.options.url}/export?bbox={bbox-epsg-3857}&${params.toString()}`
                ],
                tileSize,
                ...this.rasterSrcOptions
            }
        }

        _createSource () {
            this._map.addSource(this._sourceId, this._source);
        }

        // This requires hooking into some undocumented methods
        _updateSource () {
            const src = this._map.getSource(this._sourceId);
            src.tiles[0] = this._source.tiles[0];
            src._options = this._source;

            // Old MapboxGL and MaplibreGL
            if (this._map.style.sourceCaches) {
                this._map.style.sourceCaches[this._sourceId].clearTiles();
                this._map.style.sourceCaches[this._sourceId].update(this._map.transform);
            } else if (this._map.style._otherSourceCaches) {
                this._map.style.sourceCaches[this._sourceId].clearTiles();
                this._map.style.sourceCaches[this._sourceId].update(this._map.transform);
            }
        }

        setLayerDefs (obj) {
            this.esriServiceOptions.layerDefs = obj;
            this._updateSource();
        }

        setLayers (arr) {
            this.esriServiceOptions.layers = arr;
            this._updateSource();
        }

        setDate (from, to) {
            this.esriServiceOptions.from = from;
            this.esriServiceOptions.to = to;
            this._updateSource();
        }

        setAttributionFromService () {
            if (this._serviceMetadata) updateAttribution(this._serviceMetadata.copyrightText, this._sourceId, this._map);
            else {
                this.getMetadata()
                    .then(() => {
                        updateAttribution(this._serviceMetadata.copyrightText, this._sourceId, this._map);
                    });
            }
        }

        getMetadata() {
            if (this._serviceMetadata !== null) return Promise.resolve(this._serviceMetadata)
            return new Promise((resolve, reject) => {
                getServiceDetails(this.esriServiceOptions.url, this.esriServiceOptions.fetchOptions)
                    .then((data) => {
                        this._serviceMetadata = data;
                        resolve(this._serviceMetadata);
                    })
                    .catch(err => reject(err));
            })
        }


        get _layersStrIdentify () {
            return this._layersStr.replace('show', 'visible')
        }

        identify (lnglat, returnGeometry) {
            const canvas = this._map.getCanvas();
            const bounds = this._map.getBounds().toArray();
            returnGeometry = returnGeometry ? returnGeometry : false;
            const params = new URLSearchParams({
                sr: 4326,
                geometryType: 'esriGeometryPoint',
                geometry: JSON.stringify({
                    x: lnglat.lng,
                    y: lnglat.lat,
                    spatialReference: {
                        wkid: 4326
                    }
                }),
                tolerance: 3,
                returnGeometry,
                imageDisplay: `${canvas.width},${canvas.height},96`,
                mapExtent: `${bounds[0][0]},${bounds[0][1]},${bounds[1][0]},${bounds[1][1]}`,
                layers: this._layersStrIdentify,
                layerDefs: this._layerDefs,
                time: this._time,
                f: 'json'
            });

            return new Promise((resolve, reject) => {
                fetch(`${this.esriServiceOptions.url}/identify?${params.toString()}`, this.esriServiceOptions.fetchOptions)
                    .then(response => response.json())
                    .then(data => resolve(data))
                    .catch(error => reject(error));
            })
        }
    }

    class TiledMapService {

        constructor (sourceId, map, esriServiceOptions, rasterSrcOptions) {
            if (!esriServiceOptions.url) throw new Error('A url must be supplied as part of the esriServiceOptions object.')

            esriServiceOptions.url = cleanTrailingSlash(esriServiceOptions.url);

            this._sourceId = sourceId;
            this._map = map;

            this.rasterSrcOptions = rasterSrcOptions;
            this.esriServiceOptions = esriServiceOptions;
            this._createSource();

            this._serviceMetadata = null;
            if (esriServiceOptions.getAttributionFromService) this.setAttributionFromService();
        }

        get _source () {

            return {
                ...this.rasterSrcOptions,
                type: 'raster',
                tiles: [
                    `${this.esriServiceOptions.url}/tile/{z}/{y}/{x}`
                ],
                tileSize: 256
            }
        }

        _createSource () {
            this._map.addSource(this._sourceId, this._source);
        }

        setAttributionFromService () {
            if (this._serviceMetadata) updateAttribution(this._serviceMetadata.copyrightText, this._sourceId, this._map);
            else {
                this.getMetadata()
                    .then(() => {
                        updateAttribution(this._serviceMetadata.copyrightText, this._sourceId, this._map);
                    });
            }
        }

        getMetadata () {
            if (this._serviceMetadata !== null) return Promise.resolve()
            return new Promise((resolve, reject) => {
                getServiceDetails(this.esriServiceOptions.url, this.esriServiceOptions.fetchOptions)
                    .then((data) => {
                        this._serviceMetadata = data;
                        resolve(data);
                    })
                    .catch(err => reject(err));
            })
        }
    }

    class ImageService {

        constructor (sourceId, map, esriServiceOptions, rasterSrcOptions) {
            if (!esriServiceOptions.url) throw new Error('A url must be supplied as part of the esriServiceOptions object.')

            esriServiceOptions.url = cleanTrailingSlash(esriServiceOptions.url);

            this._sourceId = sourceId;
            this._map = map;

            this._defaultEsriOptions = {
                format: 'jpgpng',
                dpi: 96,
                getAttributionFromService: true
            };

            this.rasterSrcOptions = rasterSrcOptions;
            this.esriServiceOptions = esriServiceOptions;
            this._createSource();

            this._serviceMetadata = null;

            if (this.options.getAttributionFromService) this.setAttributionFromService();
        }

        get options () {
            return {
                ...this._defaultEsriOptions,
                ...this.esriServiceOptions
            }
        }

        get _time () {
            if (!this.options.to) return false
            let from = this.options.from;
            let to = this.options.to;
            if (from instanceof Date) from = from.valueOf();
            if (to instanceof Date) to = to.valueOf();

            return `${from},${to}`
        }

        get _source () {
            const tileSize = this.rasterSrcOptions ? this.rasterSrcOptions.tileSize ? this.rasterSrcOptions.tileSize : 256 : 256;
            // These are the bare minimum parameters
            const params = new URLSearchParams({
                bboxSR: 3857,
                imageSR: 3857,
                format: this.options.format,
                size: [tileSize, tileSize],
                f: 'image'
            });

            // These are optional params
            if (this._time) params.append('time', this._time);
            if (this.options.mosaicRule) params.append('mosaicRule', JSON.stringify(this.options.mosaicRule));
            if (this.options.renderingRule) params.append('renderingRule', JSON.stringify(this.options.renderingRule));

            return {
                type: 'raster',
                tiles: [
                    `${this.options.url}/exportImage?bbox={bbox-epsg-3857}&${params.toString()}`
                ],
                tileSize,
                ...this.rasterSrcOptions
            }
        }

        _createSource () {
            this._map.addSource(this._sourceId, this._source);
        }

        // This requires hooking into some undocumented methods
        _updateSource () {
            const src = this._map.getSource(this._sourceId);
            src.tiles[0] = this._source.tiles[0];
            src._options = this._source;

            // Old MapboxGL and MaplibreGL
            if (this._map.style.sourceCaches) {
                this._map.style.sourceCaches[this._sourceId].clearTiles();
                this._map.style.sourceCaches[this._sourceId].update(this._map.transform);
            } else if (this._map.style._otherSourceCaches) {
                this._map.style.sourceCaches[this._sourceId].clearTiles();
                this._map.style.sourceCaches[this._sourceId].update(this._map.transform);
            }
        }

        setDate (from, to) {
            this.esriServiceOptions.from = from;
            this.esriServiceOptions.to = to;
            this._updateSource();
        }

        setRenderingRule (rule) {
            this.esriServiceOptions.renderingRule = rule;
            this._updateSource();
        }

        setMosiacRule (rule) {
            this.esriServiceOptions.mosaicRule = rule;
            this._updateSource();
        }

        setAttributionFromService () {
            if (this._serviceMetadata) updateAttribution(this._serviceMetadata.copyrightText, this._sourceId, this._map);
            else {
                this.getMetadata()
                    .then(() => {
                        updateAttribution(this._serviceMetadata.copyrightText, this._sourceId, this._map);
                    });
            }
        }

        getMetadata() {
            if (this._serviceMetadata !== null) return Promise.resolve(this._serviceMetadata)
            return new Promise((resolve, reject) => {
                getServiceDetails(this.esriServiceOptions.url, this.esriServiceOptions.fetchOptions)
                    .then((data) => {
                        this._serviceMetadata = data;
                        resolve(this._serviceMetadata);
                    })
                    .catch(err => reject(err));
            })
        }

        identify (lnglat, returnGeometry) {
            const canvas = this._map.getCanvas();
            const bounds = this._map.getBounds().toArray();
            returnGeometry = returnGeometry ? returnGeometry : false;
            const params = new URLSearchParams({
                sr: 4326,
                geometryType: 'esriGeometryPoint',
                geometry: JSON.stringify({
                    x: lnglat.lng,
                    y: lnglat.lat,
                    spatialReference: {
                        wkid: 4326
                    }
                }),
                tolerance: 3,
                returnGeometry,
                imageDisplay: `${canvas.width},${canvas.height},96`,
                mapExtent: `${bounds[0][0]},${bounds[0][1]},${bounds[1][0]},${bounds[1][1]}`,
                layers: this._layersStr,
                layerDefs: this._layerDefs,
                time: this._time,
                f: 'json'
            });

            return new Promise((resolve, reject) => {
                fetch(`${this.esriServiceOptions.url}/identify?${params.toString()}`, this.esriServiceOptions.fetchOptions)
                    .then(response => response.json())
                    .then(data => resolve(data))
                    .catch(error => reject(error));
            })
        }
    }

    class VectorBasemapStyle {

        constructor (styleName, apikey) {
            if (!apikey) throw new Error('An Esri API Key must be supplied to consume vector basemap styles')

            if (!styleName) styleName = 'ArcGIS:Streets';
            this.styleName = styleName;
            this._apikey = apikey;
        }

        get styleUrl () {
            return `https://basemaps-api.arcgis.com/arcgis/rest/services/styles/${this.styleName}?type=style&apiKey=${this._apikey}`
        }

        setStyle (styleName) {
            this.styleName = styleName;
        }

    }

    class VectorTileService {

        constructor (sourceId, map, esriServiceOptions, vectorSrcOptions) {
            if (!esriServiceOptions.url) throw new Error('A url must be supplied as part of the esriServiceOptions object.')

            esriServiceOptions.url = cleanTrailingSlash(esriServiceOptions.url);

            this._sourceId = sourceId;
            this._map = map;

            this._defaultEsriOptions = {
                useDefaultStyle: true
            };

            this.vectorSrcOptions = vectorSrcOptions;
            this.esriServiceOptions = esriServiceOptions;

            this._serviceMetadata = null;
            this._defaultStyleData = null;

            this._createSource();

        }

        get options () {
            return {
                ...this._defaultEsriOptions,
                ...this.esriServiceOptions
            }
        }

        get _tileUrl () {
            if (this._serviceMetadata === null) return '/tile/{z}/{y}/{x}.pbf'
            return this._serviceMetadata.tiles[0]
        }

        get _source () {
            return {
                ...this.vectorSrcOptions,
                type: 'vector',
                tiles: [
                    `${this.options.url}/${this._tileUrl}`
                ],
            }
        }

        _createSource () {
            this._map.addSource(this._sourceId, this._source);
        }

        get defaultStyle () {
            if (this._defaultStyleData === null) return {}
            return {
                type: this._defaultStyleData.type,
                source: this._sourceId,
                'source-layer': this._defaultStyleData['source-layer'],
                layout: this._defaultStyleData['layout'],
                paint: this._defaultStyleData['paint']
            }
        }

        get _styleUrl () {
            if (this._serviceMetadata === null) return 'resources/styles'
            return `${this.options.url}/${this._serviceMetadata.defaultStyles}`
        }

        getStyle () {
            if (this._defaultStyleData !== null) return Promise.resolve(this._defaultStyleData)
            return new Promise((resolve, reject) => {
                if (this._serviceMetadata !== null) {
                    this.getMetadata()
                        .then(() => {
                            this._retrieveStyle()
                                .then(() => {
                                    resolve(this._defaultStyleData);
                                })
                                .catch(error => reject(error));
                        })
                        .catch(error => reject(error));
                } else {
                    this._retrieveStyle()
                        .then(() => {
                            resolve(this._defaultStyleData);
                        })
                        .catch(error => reject(error));
                }
            })
        }

        _retrieveStyle () {
            return new Promise((resolve, reject) => {
                fetch(`${this.options.url}/${this._styleUrl}`, this.esriServiceOptions.fetchOptions)
                    .then(response => response.json())
                    .then((data) => {
                        this._defaultStyleData = data.layers[0];
                        resolve();
                    })
                    .catch(error => reject(error));
            })
        }

        getMetadata () {
            if (this._serviceMetadata !== null) return Promise.resolve(this._serviceMetadata)
            return new Promise((resolve, reject) => {
                getServiceDetails(this.esriServiceOptions.url, this.esriServiceOptions.fetchOptions)
                    .then((data) => {
                        this._serviceMetadata = data;
                        resolve(this._serviceMetadata);
                    })
                    .catch(err => reject(err));
            })
        }
    }

    exports.DynamicMapService = DynamicMapService;
    exports.ImageService = ImageService;
    exports.TiledMapService = TiledMapService;
    exports.VectorBasemapStyle = VectorBasemapStyle;
    exports.VectorTileService = VectorTileService;

    Object.defineProperty(exports, '__esModule', { value: true });

})));
