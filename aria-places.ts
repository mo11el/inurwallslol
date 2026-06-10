// ============================================================
// aria-places.ts  (keyless edition)
// Local business search for Aria using OpenStreetMap data.
// Zero API keys. Zero cost. No rate-limit billing surprises.
//
// Stack:
//   Nominatim (OSM)  — city/neighborhood name → lat/lng
//   Overpass API     — lat/lng + category → business list
//   Google Maps link — tappable deep-link for each result
//
// Coverage note:
//   Works well for cities and most suburbs.
//   Rural or very niche spots may have thinner OSM data.
//
// Rate limits (be a good citizen):
//   Nominatim: 1 req/sec max. We cache all geocodes.
//   Overpass:  no hard limit but heavy queries get throttled.
//              15-min result cache keeps requests minimal.
//
// No install needed — uses native fetch.
//
// Import in aria-agent.ts:
//   import { PlacesEngine } from "./aria-places";
//   const places = new PlacesEngine();
//
// In handleMessage(), before callAria():
//   const handled = await places.handleIntent(text, msg.chatId, sdk);
//   if (handled) continue;
// ============================================================

// ─── ENDPOINTS ───────────────────────────────────────────────

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS  = "https://overpass-api.de/api/interpreter";

// Required by Nominatim ToS — identify your app
const USER_AGENT = "AriaReply/1.0 (ariareply.com)";

// ─── TYPES ───────────────────────────────────────────────────

interface LatLng {
  lat: number;
  lng: number;
}

interface PlaceResult {
  name:     string;
  address:  string;
  lat:      number;
  lng:      number;
  tags:     Record<string, string>;
  osmType:  "node" | "way" | "relation";
  osmId:    number;
}

interface SDK {
  send(chatId: string, content: string): Promise<void>;
}

// ─── CATEGORY MAP ────────────────────────────────────────────
// Maps plain-language search terms to OSM amenity/cuisine tags.
// Overpass uses these to filter results.

interface OsmCategory {
  amenity?:  string[];
  cuisine?:  string[];
  shop?:     string[];
  leisure?:  string[];
  tourism?:  string[];
}

const CATEGORY_MAP: Record<string, OsmCategory> = {
  // Food & drink — broad
  restaurant:    { amenity: ["restaurant"] },
  restaurants:   { amenity: ["restaurant"] },
  food:          { amenity: ["restaurant", "fast_food", "cafe"] },
  eat:           { amenity: ["restaurant", "fast_food"] },
  dining:        { amenity: ["restaurant"] },

  // Specific cuisines
  pizza:         { amenity: ["restaurant", "fast_food"], cuisine: ["pizza"] },
  sushi:         { amenity: ["restaurant"],              cuisine: ["sushi", "japanese"] },
  japanese:      { amenity: ["restaurant"],              cuisine: ["japanese", "sushi", "ramen"] },
  ramen:         { amenity: ["restaurant"],              cuisine: ["ramen", "japanese"] },
  italian:       { amenity: ["restaurant"],              cuisine: ["italian", "pizza"] },
  mexican:       { amenity: ["restaurant", "fast_food"], cuisine: ["mexican"] },
  chinese:       { amenity: ["restaurant"],              cuisine: ["chinese"] },
  indian:        { amenity: ["restaurant"],              cuisine: ["indian"] },
  thai:          { amenity: ["restaurant"],              cuisine: ["thai"] },
  mediterranean: { amenity: ["restaurant"],              cuisine: ["mediterranean", "greek"] },
  greek:         { amenity: ["restaurant"],              cuisine: ["greek"] },
  french:        { amenity: ["restaurant"],              cuisine: ["french"] },
  korean:        { amenity: ["restaurant"],              cuisine: ["korean"] },
  vietnamese:    { amenity: ["restaurant"],              cuisine: ["vietnamese"] },
  american:      { amenity: ["restaurant"],              cuisine: ["american", "burger"] },
  seafood:       { amenity: ["restaurant"],              cuisine: ["seafood", "fish_and_chips"] },
  steak:         { amenity: ["restaurant"],              cuisine: ["steak_house", "american"] },
  burger:        { amenity: ["restaurant", "fast_food"], cuisine: ["burger"] },
  bbq:           { amenity: ["restaurant"],              cuisine: ["barbecue", "bbq"] },

  // Cafe / coffee
  coffee:        { amenity: ["cafe"] },
  cafe:          { amenity: ["cafe"] },
  cafes:         { amenity: ["cafe"] },
  "coffee shop": { amenity: ["cafe"] },
  espresso:      { amenity: ["cafe"] },

  // Bars & nightlife
  bar:           { amenity: ["bar", "pub"] },
  bars:          { amenity: ["bar", "pub"] },
  pub:           { amenity: ["pub", "bar"] },
  cocktail:      { amenity: ["bar"] },
  wine:          { amenity: ["bar"], shop: ["wine"] },
  brewery:       { amenity: ["bar"], shop: ["brewing"] },

  // Brunch / breakfast
  brunch:        { amenity: ["restaurant", "cafe"] },
  breakfast:     { amenity: ["restaurant", "cafe"] },

  // Fast food
  "fast food":   { amenity: ["fast_food"] },

  // Bakery / sweets
  bakery:        { amenity: ["cafe"], shop: ["bakery"] },
  pastry:        { shop: ["bakery", "pastry"] },
  dessert:       { amenity: ["ice_cream", "cafe"] },
  "ice cream":   { amenity: ["ice_cream"] },

  // Grocery & shopping
  grocery:       { shop: ["supermarket", "grocery"] },
  supermarket:   { shop: ["supermarket"] },
  pharmacy:      { amenity: ["pharmacy"] },
  gas:           { amenity: ["fuel"] },
  "gas station": { amenity: ["fuel"] },

  // Services
  gym:           { leisure: ["fitness_centre"] },
  hotel:         { tourism: ["hotel", "motel"] },
  spa:           { leisure: ["spa"] },
  salon:         { shop: ["hairdresser", "beauty"] },
  bank:          { amenity: ["bank", "atm"] },
  atm:           { amenity: ["atm"] },

  // Entertainment
  park:          { leisure: ["park"] },
  museum:        { tourism: ["museum"] },
  cinema:        { amenity: ["cinema"] },
  theater:       { amenity: ["theatre", "cinema"] },
};

function resolveCategory(searchTerm: string): OsmCategory {
  const lower = searchTerm.toLowerCase().trim();

  // Exact match first
  if (CATEGORY_MAP[lower]) return CATEGORY_MAP[lower];

  // Partial match — find the longest key that the search term contains
  let best: OsmCategory | null = null;
  let bestLen = 0;
  for (const [key, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key) && key.length > bestLen) {
      best    = cat;
      bestLen = key.length;
    }
  }

  // Fallback: treat as a broad restaurant search
  return best ?? { amenity: ["restaurant", "cafe", "fast_food"] };
}

// ─── OVERPASS QUERY BUILDER ──────────────────────────────────

function buildOverpassQuery(cat: OsmCategory, center: LatLng, radiusM = 5000): string {
  // Build a union of node/way queries for each tag combination
  const lines: string[] = [];

  const addBlock = (key: string, values: string[]) => {
    for (const val of values) {
      lines.push(`node["${key}"="${val}"](around:${radiusM},${center.lat},${center.lng});`);
      lines.push(`way["${key}"="${val}"](around:${radiusM},${center.lat},${center.lng});`);
    }
  };

  if (cat.amenity)  addBlock("amenity", cat.amenity);
  if (cat.shop)     addBlock("shop",    cat.shop);
  if (cat.leisure)  addBlock("leisure", cat.leisure);
  if (cat.tourism)  addBlock("tourism", cat.tourism);

  // If cuisine filter exists, also scope by cuisine inside amenity:restaurant
  if (cat.cuisine && cat.amenity) {
    for (const c of cat.cuisine) {
      lines.push(`node["amenity"="restaurant"]["cuisine"~"${c}",i](around:${radiusM},${center.lat},${center.lng});`);
      lines.push(`way["amenity"="restaurant"]["cuisine"~"${c}",i](around:${radiusM},${center.lat},${center.lng});`);
    }
  }

  return `[out:json][timeout:15];\n(\n  ${lines.join("\n  ")}\n);\nout center 20;`;
}

// ─── NOMINATIM — GEOCODING ────────────────────────────────────

const geocodeCache = new Map<string, LatLng | null>();
let lastNominatimCall = 0;

async function geocode(location: string): Promise<LatLng | null> {
  const key = location.toLowerCase().trim();
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  // Respect Nominatim's 1 req/sec ToS
  const now     = Date.now();
  const elapsed = now - lastNominatimCall;
  if (elapsed < 1100) await new Promise((r) => setTimeout(r, 1100 - elapsed));
  lastNominatimCall = Date.now();

  const url = `${NOMINATIM}/search?q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=0`;
  const res  = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept":     "application/json",
    },
  });

  if (!res.ok) {
    geocodeCache.set(key, null);
    return null;
  }

  const data = await res.json() as { lat: string; lon: string }[];
  if (!data.length) {
    geocodeCache.set(key, null);
    return null;
  }

  const result: LatLng = { lat: parseFloat(data[0]!.lat), lng: parseFloat(data[0]!.lon) };
  geocodeCache.set(key, result);
  return result;
}

// ─── OVERPASS — PLACE SEARCH ──────────────────────────────────

async function overpassSearch(query: string): Promise<PlaceResult[]> {
  const res = await fetch(OVERPASS, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":   USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    console.error(`[Places] Overpass error: ${res.status}`);
    return [];
  }

  const data = await res.json() as {
    elements: {
      type:   "node" | "way" | "relation";
      id:     number;
      lat?:   number;
      lon?:   number;
      center?: { lat: number; lon: number };
      tags?:  Record<string, string>;
    }[];
  };

  return (data.elements ?? [])
    .filter((el) => el.tags?.name)   // must have a name
    .map((el) => {
      const lat = el.lat ?? el.center?.lat ?? 0;
      const lng = el.lon ?? el.center?.lon ?? 0;
      const tags = el.tags ?? {};

      // Build a human-readable address from OSM tags
      const addrParts = [
        tags["addr:housenumber"],
        tags["addr:street"],
        tags["addr:city"],
        tags["addr:state"],
      ].filter(Boolean);

      return {
        name:    tags.name!,
        address: addrParts.length > 0 ? addrParts.join(" ") : tags["addr:full"] ?? "",
        lat,
        lng,
        tags,
        osmType: el.type,
        osmId:   el.id,
      };
    })
    .filter((p) => p.name.length > 0);
}

// ─── RESULT CACHE (15 min) ────────────────────────────────────

interface CacheEntry { results: PlaceResult[]; exp: number; }
const resultCache = new Map<string, CacheEntry>();

function cacheKey(term: string, location: string): string {
  return `${term.toLowerCase()}::${location.toLowerCase()}`;
}

function getCached(term: string, location: string): PlaceResult[] | null {
  const entry = resultCache.get(cacheKey(term, location));
  if (!entry || Date.now() > entry.exp) { resultCache.delete(cacheKey(term, location)); return null; }
  return entry.results;
}

function setCached(term: string, location: string, results: PlaceResult[]): void {
  resultCache.set(cacheKey(term, location), { results, exp: Date.now() + 15 * 60_000 });
}

// ─── FORMATTERS ───────────────────────────────────────────────

const EMOJI_MAP: [RegExp, string][] = [
  [/pizza/i,                          "🍕"],
  [/sushi|japanese/i,                 "🍣"],
  [/ramen|noodle/i,                   "🍜"],
  [/burger|fast_food/i,               "🍔"],
  [/mexican|taco/i,                   "🌮"],
  [/italian/i,                        "🍝"],
  [/chinese/i,                        "🥢"],
  [/indian/i,                         "🍛"],
  [/thai/i,                           "🍜"],
  [/seafood|fish/i,                   "🦞"],
  [/steak|bbq|barbecue/i,             "🥩"],
  [/cafe|coffee|espresso/i,           "☕️"],
  [/bar|pub|cocktail|brewery/i,       "🍸"],
  [/bakery|pastry|bread/i,            "🥐"],
  [/ice_cream|dessert/i,              "🍦"],
  [/mediterranean|greek/i,            "🫒"],
  [/french/i,                         "🥖"],
  [/korean/i,                         "🥘"],
  [/restaurant/i,                     "🍽️"],
  [/gym|fitness/i,                    "💪"],
  [/hotel|motel/i,                    "🏨"],
  [/spa|beauty|salon/i,               "💆"],
  [/pharmacy|chemist/i,               "💊"],
  [/supermarket|grocery/i,            "🛒"],
  [/fuel|gas/i,                       "⛽️"],
  [/bank|atm/i,                       "🏦"],
  [/park/i,                           "🌳"],
  [/museum/i,                         "🏛️"],
  [/cinema|theatre|theater/i,         "🎬"],
];

function pickEmoji(place: PlaceResult, searchTerm: string): string {
  const haystack = [
    searchTerm,
    place.tags.amenity  ?? "",
    place.tags.cuisine  ?? "",
    place.tags.shop     ?? "",
    place.tags.leisure  ?? "",
  ].join(" ").toLowerCase();

  for (const [re, emoji] of EMOJI_MAP) {
    if (re.test(haystack)) return emoji;
  }
  return "📍";
}

function mapsLink(place: PlaceResult): string {
  // Tappable Google Maps link that opens the Maps app on iPhone
  if (place.address) {
    return `https://maps.google.com/?q=${encodeURIComponent(place.name + " " + place.address)}`;
  }
  return `https://maps.google.com/?q=${encodeURIComponent(place.name)}&ll=${place.lat},${place.lng}`;
}

function formatPlace(place: PlaceResult, searchTerm: string): string {
  const emoji   = pickEmoji(place, searchTerm);
  const cuisine = place.tags.cuisine
    ? ` (${place.tags.cuisine.replace(/;/g, ", ")})`
    : "";
  const link    = mapsLink(place);
  return `${emoji} ${place.name}${cuisine}\n${link}`;
}

const INTROS = (term: string, location: string) => [
  `here are some ${term} spots in ${location}:`,
  `solid options for ${term} near ${location}:`,
  `found these in ${location}:`,
  `a few ${term} picks near ${location}:`,
  `${term} in ${location} worth checking out:`,
];
let lastIntroIdx = -1;

function pickIntro(term: string, location: string): string {
  const arr = INTROS(term, location);
  let idx: number;
  do { idx = Math.floor(Math.random() * arr.length); }
  while (idx === lastIntroIdx && arr.length > 1);
  lastIntroIdx = idx;
  return arr[idx]!;
}

// ─── INTENT DETECTION ─────────────────────────────────────────

const INTENT_PATTERNS: RegExp[] = [
  /find (?:me )?(?:a |an |some )?(.+?)\s+(?:in|near|around|at)\s+(.+?)(?:\?|$)/i,
  /(?:recommend|suggest|show me)\s+(?:some |a )?(.+?)\s+(?:in|near|around)\s+(.+?)(?:\?|$)/i,
  /(?:best|good|great|top|any|some)\s+(?:good |great |decent )?(.+?)\s+(?:in|near|around|at)\s+(.+?)(?:\?|$)/i,
  /where(?:'s| is)(?: a| the)?\s+(?:good|best|nearest?)?\s*(.+?)\s+(?:in|near|around)\s+(.+?)(?:\?|$)/i,
  /what(?:'s| is)(?: a| the)?\s+(?:good|best)?\s*(.+?)\s+(?:in|near)\s+(.+?)(?:\?|$)/i,
  // "restaurants in Manhasset"
  /^(restaurants?|coffee|cafes?|bars?|pubs?|sushi|pizza|food)\s+(?:in|near|around)\s+(.+?)(?:\?|$)/i,
];

// "I'm in East Hampton. Recommend some restaurants."
const LOCATION_FIRST =
  /(?:i(?:'m| am)(?: currently)? (?:in|at)|just (?:got to|arrived in?)|visiting)\s+([^.?!,]+)[.?!,]\s*(?:recommend|find|suggest|any|where|what)\s+(?:some |a |an )?(.+?)(?:\?|$)/i;

export interface ParsedPlaceQuery {
  searchTerm: string;
  location:   string;
}

export function parsePlaceQuery(text: string): ParsedPlaceQuery | null {
  const lf = text.match(LOCATION_FIRST);
  if (lf) {
    return {
      location:   lf[1]!.trim(),
      searchTerm: cleanTerm(lf[2]!.trim()),
    };
  }

  for (const re of INTENT_PATTERNS) {
    const m = text.match(re);
    if (m?.[1] && m?.[2]) {
      return {
        searchTerm: cleanTerm(m[1].trim()),
        location:   m[2].trim(),
      };
    }
  }

  return null;
}

function cleanTerm(raw: string): string {
  return raw
    .replace(/^(?:some|a|an|the|good|great|best|any|decent|nearby)\s+/i, "")
    .replace(/\s+(?:place|places|spot|spots|option|options)$/i,           "")
    .trim();
}

// ─── PLACES ENGINE ────────────────────────────────────────────

export class PlacesEngine {

  async handleIntent(text: string, chatId: string, messaging: any): Promise<boolean> {
    const query = parsePlaceQuery(text);
    if (!query) return false;

    const { searchTerm, location } = query;
    console.log(`[Places] "${searchTerm}" in "${location}"`);

    await messaging.sendRaw(chatId, `looking up ${searchTerm} in ${location}...`);

    try {
      const results = await this.search(searchTerm, location);

      if (!results.length) {
        await messaging.sendRaw(
          chatId,
          `couldn't find ${searchTerm} near ${location} in OpenStreetMap. the data's thinner in some areas — try a broader term.`
        );
        return true;
      }

      // Intro bubble
      await messaging.sendRaw(chatId, pickIntro(searchTerm, location));
      await new Promise((r) => setTimeout(r, 500));

      // Each result as its own iMessage bubble
      const top = results.slice(0, 5);
      for (let i = 0; i < top.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 450));
        await messaging.sendRaw(chatId, formatPlace(top[i]!, searchTerm));
      }

      // Tail if there are more
      if (results.length > 5) {
        await new Promise((r) => setTimeout(r, 700));
        await messaging.sendRaw(chatId, `${results.length - 5} more found — want me to filter by something specific?`);
      }

    } catch (err) {
      console.error("[Places] Error:", err);
      await messaging.sendRaw(chatId, "ran into a snag with the map lookup. try again in a sec.");
    }

    return true;
  }

  async search(searchTerm: string, location: string): Promise<PlaceResult[]> {
    // Cache check
    const cached = getCached(searchTerm, location);
    if (cached) return cached;

    // Geocode location → lat/lng
    const center = await geocode(location);
    if (!center) {
      console.warn(`[Places] Couldn't geocode "${location}"`);
      return [];
    }

    // Resolve search term to OSM tags
    const cat   = resolveCategory(searchTerm);
    const oql   = buildOverpassQuery(cat, center);
    const raw   = await overpassSearch(oql);

    // Deduplicate by name (OSM sometimes returns the same place as node + way)
    const seen  = new Set<string>();
    const dedup = raw.filter((p) => {
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Sort: prefer results with more complete tags (address, cuisine)
    dedup.sort((a, b) => {
      const scoreA = Object.keys(a.tags).length;
      const scoreB = Object.keys(b.tags).length;
      return scoreB - scoreA;
    });

    setCached(searchTerm, location, dedup);
    return dedup;
  }
}
