version 1.3

import "lib/ogc_process.wdl" as ogc_process
import "lib/struct/feature_collection.wdl" as FeatureCollection
import "lib/struct/groundwater_level.wdl" as GroundwaterLevel
import 'subsidence_analysis.wdl' as subsidence_analysis

workflow main {
    meta {
        description: "Provides construction analysis on provided area, using the groundwater level measured in the area"
        outputs: {
            buildArea: "All areas/polygons where construction is possible",
        }
    }

    parameter_meta {
        geojson: "The scope of the analysis based on a bounding box"
        registry_url: "The registry to communicate with"

        statistic: "Which level was taken: highest, lowest or median"
        datetime: "The period of the measurements considered, as 'start/end'"
        maxScreenDepth: "How far below the surface a filter screen could begin (m)"
        observationTypes: "The BRO observation types that counted"
        statuses: "The BRO assessment statuses that counted"

        thickness: "The surcharge thickness in metres, applied to every feature of the geojson"
        threshold: "The threshold to use for subsidence result categorisation"
    }

    input {
        FeatureCollection geojson
        # A workflow runs inside a Docker container so should refer to parent machine using Docker's routing
        String registry_url = "http://host.docker.internal:8090"

        String statistic
        String datetime
        Float maxScreenDepth
        Array[String] observationTypes
        Array[String] statuses

        Float thickness
        Float threshold
    }

    call ogc_process.execute as groundwater {
        registry_url,
        process_id = "subsidence_groundwater-level",
        # Downloading the measurements of every series from the BRO takes a while
        poll_interval_seconds = 5,
        max_poll_attempts = 24,
        process_inputs = read_string(write_json(object {
            geojson: object { value: geojson, mediaType: "application/geo+json" },
            statistic: statistic,
            datetime: datetime,
            maxScreenDepth: maxScreenDepth,
            observationTypes: observationTypes,
            statuses: statuses,
        })),
    }

    GroundwaterLevel groundwater_results = read_json(groundwater.results)

    call subsidence_analysis.main as analysis {
        geojson,
        gw = groundwater_results.level,
        thickness,
        threshold,
        registry_url,
    }

    output {
        FeatureCollection buildArea = analysis.buildArea
    }
}
