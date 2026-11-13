// Turns a CityJSON model into GeoJSON building footprints, so hubPreview.js's
// Leaflet map can show a recipe result that is a 3D city model rather than
// GeoJSON — roofer's building reconstruction, whose saved result only links
// to its CityJSON export (`artifacts.cityjson.href`).
//
// Only the footprint is drawn: each building's LoD0 surface, or, without
// one, the ground surfaces of its (or its parts') solids. That is what a 2D
// map can show; the heights go into each footprint's popup.

// Recognises a link to a CityJSON document anywhere in a result: an object
// with an `href`, under a `cityjson` key, or typed or named as CityJSON.
function isCityJsonLink(key, value) {
  if (!value || typeof value !== "object" || typeof value.href !== "string") return false;
  return /^cityjson$/i.test(key) || /city\+?json/i.test(value.type || "") || /cityjson/i.test(value.href);
}

/** Every distinct CityJSON link in a result value, in the order found. */
export function findCityJsonLinks(value) {
  const hrefs = new Set();
  (function walk(v, key) {
    if (!v || typeof v !== "object") return;
    if (isCityJsonLink(key, v)) hrefs.add(v.href);
    for (const [k, child] of Object.entries(v)) walk(child, k);
  })(value, "");
  return [...hrefs];
}

// Fetched once per page load: several saved results often link to the same
// model, and a model can run to megabytes.
const fetched = new Map();

/** Fetches the CityJSON documents a result links to and returns their
 * footprints as one GeoJSON FeatureCollection, or null if it links to none. */
export async function cityJsonFootprints(result) {
  const links = findCityJsonLinks(result);
  if (!links.length) return null;
  const features = [];
  for (const href of links) {
    if (!fetched.has(href)) {
      fetched.set(
        href,
        fetch(href).then((resp) => {
          if (!resp.ok) throw new Error(`CityJSON at ${href} answered ${resp.status}`);
          return resp.json();
        })
      );
    }
    let doc;
    try {
      doc = await fetched.get(href);
    } catch (err) {
      fetched.delete(href); // let a later preview try again
      throw err;
    }
    features.push(...cityJsonToGeoJson(doc).features);
  }
  return { type: "FeatureCollection", features };
}

// EPSG code from CityJSON's `referenceSystem`, in either of its usual forms:
// "https://www.opengis.net/def/crs/EPSG/0/28992" or "urn:ogc:def:crs:EPSG::28992".
function epsgCode(doc) {
  const rs = (doc.metadata && doc.metadata.referenceSystem) || "";
  const m = String(rs).match(/EPSG.*?(\d+)\s*$/i);
  return m ? Number(m[1]) : null;
}

// Dutch RD New (EPSG:28992) to WGS84 longitude/latitude, with the published
// approximation of Schreutelkamp and Strang van Hees (accurate to about a
// metre within the Netherlands) — plenty for a map, and no projection library.
const K = [[0, 1, 3235.65389], [2, 0, -32.58297], [0, 2, -0.2475], [2, 1, -0.84978], [0, 3, -0.0655],
  [2, 2, -0.01709], [1, 0, -0.00738], [4, 0, 0.0053], [2, 3, -0.00039], [4, 1, 0.00033], [1, 1, -0.00012]];
const L_ = [[1, 0, 5260.52916], [1, 1, 105.94684], [1, 2, 2.45656], [3, 0, -0.81885], [1, 3, 0.05594],
  [3, 1, -0.05607], [0, 1, 0.01199], [3, 2, -0.00256], [1, 4, 0.00128], [0, 2, 0.00022], [2, 0, -0.00022],
  [5, 0, 0.00026]];

function rdToWgs84(x, y) {
  const dx = (x - 155000) * 1e-5;
  const dy = (y - 463000) * 1e-5;
  const sum = (terms) => terms.reduce((s, [p, q, c]) => s + c * dx ** p * dy ** q, 0);
  return [5.38720621 + sum(L_) / 3600, 52.1551744 + sum(K) / 3600];
}

function projector(doc) {
  const code = epsgCode(doc);
  if (code === 28992 || code === 7415) return rdToWgs84; // 7415 = RD New + NAP height
  if (code === 4326 || code === 4979 || code === null) return (x, y) => [x, y];
  throw new Error(`CityJSON in EPSG:${code} can't be shown on the map yet (only RD New and WGS84).`);
}

// The polygons (as arrays of rings of vertex indices) a geometry contributes
// to a footprint: all its surfaces at LoD0, else its ground surfaces.
function footprintSurfaces(geom) {
  const lod = String(geom.lod ?? "");
  const isSurface = geom.type === "MultiSurface" || geom.type === "CompositeSurface";
  if (isSurface && lod.startsWith("0")) return geom.boundaries;
  const sem = geom.semantics;
  if (!sem || !sem.values) return [];
  const isGround = (i) => i != null && sem.surfaces[i] && sem.surfaces[i].type === "GroundSurface";
  if (isSurface) return geom.boundaries.filter((_, i) => isGround(sem.values[i]));
  if (geom.type === "Solid") {
    return geom.boundaries.flatMap((shell, s) => shell.filter((_, i) => isGround((sem.values[s] || [])[i])));
  }
  return [];
}

/** A CityJSON document's buildings (its top-level city objects) as a GeoJSON
 * FeatureCollection of footprints, in WGS84. */
export function cityJsonToGeoJson(doc) {
  if (!doc || doc.type !== "CityJSON") throw new Error("Not a CityJSON document.");
  const project = projector(doc);
  const { scale = [1, 1, 1], translate = [0, 0, 0] } = doc.transform || {};
  const vertex = (i) => {
    const [x, y] = doc.vertices[i];
    return project(x * scale[0] + translate[0], y * scale[1] + translate[1]);
  };
  const ring = (indices) => {
    const coords = indices.map(vertex);
    return [...coords, coords[0]]; // GeoJSON rings are closed
  };
  const objects = doc.CityObjects || {};
  // Lowest LoD first, so a footprint comes from the simplest geometry.
  const polygonsOf = (obj) => {
    const geoms = [...(obj.geometry || [])].sort((a, b) => String(a.lod).localeCompare(String(b.lod)));
    for (const g of geoms) {
      const surfaces = footprintSurfaces(g);
      if (surfaces.length) return surfaces.map((rings) => rings.map(ring));
    }
    return [];
  };

  const features = [];
  for (const [id, obj] of Object.entries(objects)) {
    if (obj.parents && obj.parents.length) continue; // drawn through its parent
    let polygons = polygonsOf(obj);
    if (!polygons.length) polygons = (obj.children || []).flatMap((c) => (objects[c] ? polygonsOf(objects[c]) : []));
    if (!polygons.length) continue;
    const a = obj.attributes || {};
    features.push({
      type: "Feature",
      id,
      properties: {
        cityObjectId: id,
        cityObjectType: obj.type,
        // roofer (3D BAG) attribute names; absent in other CityJSON, and then left out of the popup.
        roofHeight: a.b3_h_dak_max,
        groundHeight: a.b3_h_maaiveld,
      },
      geometry: { type: "MultiPolygon", coordinates: polygons },
    });
  }
  return { type: "FeatureCollection", features };
}
