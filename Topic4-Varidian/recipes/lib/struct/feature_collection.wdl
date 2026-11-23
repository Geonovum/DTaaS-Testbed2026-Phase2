version 1.3

struct FeatureCollection {
    meta {
        description: "A GeoJSON FeatureCollection, as accepted by the subsidence process"
    }

    parameter_meta {
        type: "Always value 'FeatureCollection'"
        features: "The list of GeoJSON features of the collection"
    }

    String type
    # Each feature is the deprecated `Object` type rather than a typed `Feature` struct.
    # WDL has no union types, so a struct cannot hold a geometry that is either a Polygon
    # (3-deep coordinates) or a MultiPolygon (4-deep), nor properties that mix String and
    # Float values. Optional properties would need `Object?`, which Sprocket 0.32.0 cannot
    # coerce to.
    Array[Object] features
}

struct QualifiedFeatureCollection {
    meta {
        description: "A FeatureCollection output as an OGC results document carries it"
    }

    parameter_meta {
        value: "The FeatureCollection itself"
        mediaType: "Always 'application/geo+json'"
    }

    FeatureCollection value
    String mediaType
}
