version 1.3

struct GroundwaterCriteria {
    meta {
        description: "The choices a groundwater level was drawn with, in the notation of the groundwater-level process's inputs"
    }

    parameter_meta {
        statistic: "Which level was taken: highest, lowest or median"
        datetime: "The period of the measurements considered, as 'start/end'"
        maxScreenDepth: "How far below the surface a filter screen could begin (m)"
        observationTypes: "The BRO observation types that counted"
        statuses: "The BRO assessment statuses that counted"
    }

    String statistic
    String datetime
    Float maxScreenDepth
    Array[String] observationTypes
    Array[String] statuses
}
struct QualifiedGroundwaterCriteria {
    meta {
        description: "The criteria as an OGC results document carries them"
    }

    parameter_meta {
        value: "The criteria themselves"
    }

    GroundwaterCriteria value
}
