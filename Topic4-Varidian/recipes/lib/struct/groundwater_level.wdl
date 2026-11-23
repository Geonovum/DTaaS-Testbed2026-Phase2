version 1.3

import "groundwater_criteria.wdl" as GroundwaterCriteria

struct GroundwaterLevel {
    meta {
        description: "The results of the groundwater-level process"
    }

    parameter_meta {
        level: "The phreatic groundwater level in the area (m NAP)"
        series: "Every BRO series the level was drawn from"
        criteria: "Every choice the level was drawn with"
    }

    Float level
    # The recipe does not read the series, so they are left untyped
    Array[Object] series
    QualifiedGroundwaterCriteria criteria
}