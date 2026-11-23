version 1.3

import "lib/ogc_process.wdl" as ogc_process
import "lib/struct/feature_collection.wdl" as FeatureCollection

workflow main {
    meta {
        description: "Provides construction analysis on provided bbox"
        outputs: {
            buildArea: "All areas/polygons where construction is possible",
        }
    }

    parameter_meta {
        geojson: "The scope of the analysis based on a bounding box"
        gw: "The groundwater level (m NAP)"
        thickness: "The surcharge thickness in metres, applied to every feature of the geojson"
        threshold: "The threshold to use for subsidence result categorisation"
        registry_url: "The registry to communicate with"
    }

    input {
        FeatureCollection geojson
        Float gw
        Float thickness
        Float threshold
        # A workflow runs inside a Docker container so should refer to parent machine using Docker's routing
        String registry_url = "http://host.docker.internal:8090"
    }

    call ogc_process.execute as subsidence {
        registry_url,
        process_id = "subsidence_subsidence",
        # Subsidence process is relatively slow, therefore, polling should be done slower and longer
        poll_interval_seconds = 5,
        max_poll_attempts = 12,
        process_inputs = read_string(write_json(object {
            geojson: object { value: geojson, mediaType: "application/geo+json" },
            gw: gw,
            thickness: thickness,
        })),
    }

    Map[String, String] subsidence_results = read_json(subsidence.results)

    call ogc_process.execute as analysis {
        registry_url,
        process_id = "subsidence_geotiff-analyzer",
        process_inputs = read_string(write_json(object {
            url: subsidence_results["total"],
            threshold: threshold,
        })),
    }

    Map[String, QualifiedFeatureCollection] analysis_results = read_json(analysis.results)

    output {
        FeatureCollection buildArea = analysis_results["belowThreshold"].value
    }
}
