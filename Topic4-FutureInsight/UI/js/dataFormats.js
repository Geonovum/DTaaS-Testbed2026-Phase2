// Media types of a recipe's data inputs, and how they line up with the Hub
// Datasets catalogue.
//
// A recipe declares a data input in its CWL as `type: File` with a `format:`
// — a media-type IRI such as `iana:application/geo+json` (see the Cookbook
// Registry's `dag.data_inputs`). The Hub Datasets catalogue labels each
// resource with a short format name instead ("geojson", "wfs", "laz"). The
// aliases below are the one place that says which catalogue formats can be
// handed to a data input of a given media type.

export const IANA_MEDIA_TYPES_BASE = "https://www.iana.org/assignments/media-types/";

// media type -> catalogue `format` values a resource may carry to fit it.
export const MEDIA_TYPE_CATALOGUE_FORMATS = {
  "application/geo+json": ["geojson", "wfs"],
  "application/json": ["geojson", "json", "wfs"],
  "application/vnd.laszip": ["laz"],
  "application/vnd.las": ["las", "laz"],
};

// The media types the Orchestrator editor offers when marking a workflow
// input as a data input. `application/vnd.laszip` / `application/vnd.las`
// are what point-cloud tools commonly use; neither is IANA-registered.
export const DATA_MEDIA_TYPE_OPTIONS = [
  { mediaType: "application/geo+json", label: "GeoJSON" },
  { mediaType: "application/json", label: "JSON" },
  { mediaType: "application/vnd.laszip", label: "LAZ point cloud" },
  { mediaType: "application/vnd.las", label: "LAS point cloud" },
  { mediaType: "image/tiff; application=geotiff", label: "GeoTIFF" },
  { mediaType: "application/city+json", label: "CityJSON" },
  { mediaType: "application/gml+xml", label: "GML / XML" },
];

/** Human label for a media type ("GeoJSON", "LAZ point cloud"), or the media
 * type itself when it isn't one of the common ones. */
export function mediaTypeLabel(mediaType) {
  if (!mediaType) return "any format";
  const known = DATA_MEDIA_TYPE_OPTIONS.find((o) => o.mediaType === mediaType);
  return known ? known.label : mediaType;
}

/** Catalogue formats that fit a media type, or null for "no filter" (an
 * unknown or missing media type can't be matched against the catalogue). */
export function catalogueFormatsFor(mediaType) {
  return (mediaType && MEDIA_TYPE_CATALOGUE_FORMATS[mediaType]) || null;
}

/** A CWL `format` value (`iana:application/geo+json`, the full IANA IRI, or a
 * bare `type/subtype`) as a plain media type; null for anything else. */
export function formatToMediaType(format) {
  if (typeof format !== "string" || !format.trim()) return null;
  const f = format.trim().replace(/^["']|["']$/g, "");
  for (const prefix of ["iana:", IANA_MEDIA_TYPES_BASE, IANA_MEDIA_TYPES_BASE.replace("https:", "http:")]) {
    if (f.startsWith(prefix)) return f.slice(prefix.length);
  }
  return f.includes("/") && !f.includes(":") ? f : null;
}

/** The CWL `format` value written for a media type: `iana:<media type>`. */
export function mediaTypeToFormat(mediaType) {
  return `iana:${mediaType}`;
}

/** A CWL File value pointing at `location` — what a data input is given at
 * run time. The Cook Orchestrator turns it into an OGC by-reference input. */
export function cwlFile(location, mediaType) {
  const file = { class: "File", location };
  if (mediaType) file.format = IANA_MEDIA_TYPES_BASE + mediaType;
  return file;
}
