import geopandas as gpd
import os
import pandas as pd

# Define the folder containing the shapefiles
shapefile_folder = "routes"

# Initialize an empty list to store GeoDataFrames
gdf_list = []

# Loop through all files in the folder
for file in os.listdir(shapefile_folder):
    if file.endswith(".shp"):
        # Read each shapefile
        filepath = os.path.join(shapefile_folder, file)
        gdf = gpd.read_file(filepath)
        
        # Add a column for the route name (optional, based on filename)
        gdf["route_name"] = os.path.splitext(file)[0]
        
        # Append the GeoDataFrame to the list
        gdf_list.append(gdf)

# Combine all GeoDataFrames into a single GeoDataFrame
combined_gdf = pd.concat(gdf_list, ignore_index=True)

# Export the combined GeoDataFrame to a GeoJSON file
output_geojson = "combined_routes.geojson"
combined_gdf.to_file(output_geojson, driver="GeoJSON")

print(f"Combined GeoJSON saved to {output_geojson}")