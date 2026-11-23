version 1.3

import "expert_site_analysis.wdl" as site_analysis
import "lib/struct/feature_collection.wdl" as FeatureCollection

workflow main {
    meta {
        description: "Provides construction analysis on provided area, using the groundwater level measured in the area and fixed choices for everything else"
        outputs: {
            buildArea: "All areas/polygons where construction is possible",
        }
    }

    parameter_meta {
        geojson: "The scope of the analysis based on a bounding box"
        registry_url: "The registry to communicate with"
    }

    input {
        FeatureCollection geojson
        # A workflow runs inside a Docker container so should refer to parent machine using Docker's routing
        String registry_url = "http://host.docker.internal:8090"
    }

    # The hardcoded values which make the recipe "guided" compared to `expert_site_analysis.wdl`
    String statistic = "highest"
    String datetime = "../.."
    Float maxScreenDepth = 5.0
    Array[String] observationTypes = ["regulier_beoordeeld"]
    Array[String] statuses = ["goedgekeurd"]
    Float thickness = 1.5
    Float threshold = 0.4

    call site_analysis.main as analysis {
        geojson,
        registry_url,

        statistic,
        datetime,
        maxScreenDepth,
        observationTypes,
        statuses,

        thickness,
        threshold,
    }

    output {
        FeatureCollection buildArea = analysis.buildArea
    }
}
