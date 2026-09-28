// Named places, salmon streams, fishing districts and developed footprints of the Kodiak archipelago.
// Pure data + helpers (no THREE, no DOM): importable from any module and from Node tests.
//
// Export names and function signatures are FROZEN (other work packages import them statically). WP-PLACES owns the
// contents and may add fields; never rename or remove one.
//
// Place:     { id, name, kind, lat, lon, radius (discovery, game m), blurb, services?, onFoot?, landing?, dock?,
//              model?, district?, memorial? }
//            kind: town | village | harbor | cannery | hatchery | landmark | cape | bay | strait | island | river |
//                  lake | peak | lighthouse | wildlife | history | viewpoint
//            services ⊆ ['sell','fuel','upgrades','ice','rest']; dock = { lat, lon, heading } (water point to tie up)
//            landing = { lat, lon } beach where the skiff lands for onFoot places
//            memorial: true → quiet logbook card, no bonus, no celebratory toast (e.g. Awa'uq / Refuge Rock)
//            Added fields: real = { lat, lon } of the real feature; light = { color, period s, flashes } for
//            lighthouses; church = village church style; district = district id (filled in by resolve()).
// Stream:    { id, name, lat, lon (mouth), species: [...], closedRadius (game m, 150–350), placeId? }
// District:  { id, name, label: { lat, lon }, polygon: [{ lat, lon }, ...] }
// Footprint: { id, lat, lon, radius (game m) } — developed ground: terrain skips vegetation here
// Closed:    { id, name, lat, lon, radius (game m), reason } — extra no-fishing / no-approach zones (e.g. Marmot
//            Island sea lion rookery buffer)
//
// Coordinates are fitted to the game heightmap. The ~90 m DEM closes narrow waters (Near Island channel, St. Paul
// Harbor, Womens Bay, Settler Cove, Kupreanof Strait, Whale Pass, Sitkalidak Strait) and shallows Alitak and Olga
// bays, so settlements, docks, stream mouths and water labels sit on the nearest shore or water the game actually
// has; `real` keeps the true position. Districts follow 5 AAC 18.200 (latitude lines and midstream Shelikof Strait)
// as coarse polygons that include land.

export const PLACES = [
{
    id: "kodiak", name: "City of Kodiak", kind: "town", lat: 57.7805, lon: -152.40581, radius: 450, services: ["sell","fuel","upgrades","ice","rest"], dock: { lat: 57.75915, lon: -152.39575, heading: 2.583 }, model: "kodiak", real: { lat: 57.79, lon: -152.407 },
    blurb:
      "Kodiak stands where the Alutiiq village of Sun'aq stood; Alexander Baranov moved the Russian colony here from Three Saints Bay in 1792, making it the first capital of Russian America. Buried under a foot of Novarupta ash in 1912 and swept by the 1964 tsunami, it is today one of the nation's top fishing ports by value.",
  },
  {
    id: "st-paul-harbor", name: "St. Paul Harbor", kind: "harbor", lat: 57.76042, lon: -152.39891, radius: 160, real: { lat: 57.787, lon: -152.402 },
    blurb:
      "Downtown's small-boat harbor, behind two breakwaters, berths about 250 seiners, gillnetters, crabbers and longliners. The Russians called their settlement Pavlovskaya Gavan, St. Paul's Harbor, and the name stuck to the water in front of town.",
  },
  {
    id: "st-herman-harbor", name: "St. Herman Harbor", kind: "harbor", lat: 57.76327, lon: -152.3634, radius: 160, real: { lat: 57.7779, lon: -152.4134 },
    blurb:
      "Kodiak's newer and larger harbor, dredged in Dog Bay on Near Island, has room for some 325 vessels up to 150 feet. It is named for St. Herman, the Valaam monk who reached Kodiak with the Orthodox mission of 1794.",
  },
  {
    id: "cannery-row", name: "Cannery Row", kind: "cannery", lat: 57.76835, lon: -152.39299, radius: 180, model: "canneryRow", real: { lat: 57.7905, lon: -152.398 },
    blurb:
      "Kodiak's processing plants stand on pilings along the channel, where tenders unload around the clock in July. After the 1964 tsunami wrecked the waterfront, the Liberty ship Albert M. Boe was towed in and grounded as a cannery; as the Star of Kodiak it still processes fish today.",
  },
  {
    id: "near-island", name: "Near Island", kind: "island", lat: 57.77574, lon: -152.35452, radius: 220, real: { lat: 57.782, lon: -152.4 },
    blurb:
      "Across the channel from downtown, Near Island holds St. Herman Harbor, the Kodiak Fisheries Research Center and spruce-shaded trails. The Near Island Bridge, built in the 1980s, carries Dog Bay Road across from town.",
  },
  {
    id: "holy-resurrection", name: "Holy Resurrection Cathedral", kind: "landmark", lat: 57.78208, lon: -152.40778, radius: 90, onFoot: true, landing: { lat: 57.77743, lon: -152.3849 }, real: { lat: 57.7886, lon: -152.4053 },
    blurb:
      "Kodiak's Orthodox parish, founded by the Valaam monks in 1794, is the oldest in North America. The present church with its blue onion domes was built in 1945 after fire took its predecessor; St. Herman's relics rest inside.",
  },
  {
    id: "pillar-mountain", name: "Pillar Mountain", kind: "peak", lat: 57.79001, lon: -152.43836, radius: 220, onFoot: true, landing: { lat: 57.76507, lon: -152.40601 }, model: "turbines", real: { lat: 57.7886, lon: -152.4356 },
    blurb:
      "The 1,270-foot ridge behind town carries Kodiak Electric's six 1.5-megawatt wind turbines: three raised in 2009, Alaska's first large utility turbines, and three more in 2012. With the Terror Lake hydro plant they give Kodiak more than 99 percent renewable power.",
  },
  {
    id: "pillar-creek-hatchery", name: "Pillar Creek Hatchery", kind: "hatchery", lat: 57.80364, lon: -152.43402, radius: 200, model: "hatcherySmall", real: { lat: 57.8036, lon: -152.4341 },
    blurb:
      "Built in 1990 by the Kodiak Regional Aquaculture Association and ADF&G, Pillar Creek incubates sockeye to rebuild weak lake runs, plus coho and king salmon stocked in the road-system streams.",
  },
  {
    id: "fort-abercrombie", name: "Fort Abercrombie", kind: "history", lat: 57.84051, lon: -152.35314, radius: 200, onFoot: true, landing: { lat: 57.83668, lon: -152.33653 }, model: "bunkers", real: { lat: 57.8371, lon: -152.3531 },
    blurb:
      "Built in 1941-43 to guard the naval base, the fort mounted two 8-inch guns on Miller Point. Its concrete ready-ammunition bunker now houses the Kodiak Military History Museum, above spruce forest and tide pools.",
  },
  {
    id: "spruce-cape", name: "Spruce Cape", kind: "cape", lat: 57.82033, lon: -152.32632, radius: 220, real: { lat: 57.8203, lon: -152.3319 },
    blurb:
      "The low, grass-topped bluff at the northwest point of Chiniak Bay, backed by spruce. Bare rocks and foul ground run 0.6 mile north of it to the Hanin Rocks, so the north approach to Kodiak swings wide.",
  },
  {
    id: "hanin-rock-light", name: "Hanin Rock Light", kind: "lighthouse", lat: 57.82625, lon: -152.32711, radius: 160, model: "light", light: {color: "#ffffff",period: 6,flashes: 1}, real: { lat: 57.8347, lon: -152.3144 },
    blurb:
      "Hanin Rock Light shows from a skeleton tower 43 feet above the water on the southwest of two 30-foot rocks off Spruce Cape, marking the northeast approach to Kodiak.",
  },
  {
    id: "woody-island", name: "Woody Island", kind: "island", lat: 57.76496, lon: -152.26023, radius: 300, real: { lat: 57.779, lon: -152.3398 },
    blurb:
      "Tangirnaq to the Alutiiq. In the 1850s its dammed lake supplied ice to San Francisco through the American-Russian Commercial Company, and in 1893 Baptists opened a mission and orphanage here. The Tangirnarmiut still hold it as their tribal home.",
  },
  {
    id: "woody-island-light", name: "Woody Island Light", kind: "lighthouse", lat: 57.76782, lon: -152.30718, radius: 140, model: "light", light: {color: "#ff3b2f",period: 4,flashes: 1}, real: { lat: 57.7961, lon: -152.3383 },
    blurb:
      "A skeleton tower with a red-and-white diamond daymark on Woody Island's north point marks the passage between the island and the Kodiak shore.",
  },
  {
    id: "st-paul-harbor-light", name: "St. Paul Harbor Entrance Light", kind: "lighthouse", lat: 57.72703, lon: -152.44507, radius: 140, model: "light", light: {color: "#35ff6a",period: 4,flashes: 1}, real: { lat: 57.7389, lon: -152.43 },
    blurb:
      "A spindle tower 38 feet above the water, 0.9 mile from Cliff Point, marks the buoyed channel through the reefs of St. Paul Harbor toward Womens Bay; a racon on it paints a mark on radar screens.",
  },
  {
    id: "chiniak-bay", name: "Chiniak Bay", kind: "bay", lat: 57.71308, lon: -152.35571, radius: 900, real: { lat: 57.7131, lon: -152.3558 },
    blurb:
      "The 13-mile-wide bay between Spruce Cape and Cape Chiniak, approach to Kodiak's harbors and the Coast Guard base. Its reefs, kelp and islets make the buoys and lights worth watching at night.",
  },
  {
    id: "kalsin-bay", name: "Kalsin Bay", kind: "bay", lat: 57.65571, lon: -152.37464, radius: 450, real: { lat: 57.6166, lon: -152.4101 },
    blurb:
      "The largest indentation on the southwest side of Chiniak Bay, a good anchorage. The low valley from its head to Ugak Bay has served as a portage since long before the road.",
  },
  {
    id: "uscg-base", name: "Coast Guard Base Kodiak", kind: "landmark", lat: 57.73031, lon: -152.47288, radius: 260, model: "coastGuard", real: { lat: 57.7407, lon: -152.5044 },
    blurb:
      "The Coast Guard's largest base grew out of Naval Operating Base Kodiak, built in 1941. Cutters tie up at its Womens Bay piers and the air station's helicopters fly rescues across the Gulf of Alaska and the Bering Sea.",
  },
  {
    id: "womens-bay", name: "Womens Bay", kind: "bay", lat: 57.71234, lon: -152.42554, radius: 350, real: { lat: 57.715, lon: -152.525 },
    blurb:
      "The sheltered bay at the west end of Chiniak Bay holds the Coast Guard's cutter and cargo piers. In summer its head streams run thick with pink salmon, and Old Womens Mountain above it gives the best view of town.",
  },
  {
    id: "buskin-river", name: "Buskin River", kind: "river", lat: 57.75672, lon: -152.46006, radius: 180, real: { lat: 57.7563, lon: -152.4868 },
    blurb:
      "The Buskin runs past the airport into Chiniak Bay. Its June sockeye and late-summer coho make it Kodiak's busiest roadside fishery; the mouth is closed to commercial gear.",
  },
  {
    id: "barometer-mountain", name: "Barometer Mountain", kind: "peak", lat: 57.75503, lon: -152.5508, radius: 250, onFoot: true, landing: { lat: 57.71995, lon: -152.45382 }, real: { lat: 57.7544, lon: -152.5485 },
    blurb:
      "The steep 2,450-foot cone above the airport is Kodiak's hardest day hike, straight up the ridge. Locals read the weather off it: when Barometer wears a cloud cap, expect wind.",
  },
  {
    id: "monashka-bay", name: "Monashka Bay", kind: "bay", lat: 57.86133, lon: -152.35847, radius: 400, real: { lat: 57.8367, lon: -152.3953 },
    blurb:
      "The open bay north of town, with a surf beach and the road out to Termination Point. Monashka Creek, dammed above the bay, supplies Kodiak's drinking water.",
  },
  {
    id: "termination-point", name: "Termination Point", kind: "viewpoint", lat: 57.85499, lon: -152.40325, radius: 220, onFoot: true, landing: { lat: 57.85627, lon: -152.40237 }, real: { lat: 57.855, lon: -152.4 },
    blurb:
      "The road ends here, and a trail loops through old-growth Sitka spruce to bluffs over Narrow Strait and Marmot Bay. Its latitude is the line between the Northeast and Northwest Kodiak districts.",
  },
  {
    id: "cape-chiniak", name: "Cape Chiniak", kind: "cape", lat: 57.61978, lon: -152.15588, radius: 300, real: { lat: 57.6206, lon: -152.1543 },
    blurb:
      "The low, wooded southeast point of Chiniak Bay. South of it the spruce thins out within a few miles, and from Narrow Cape on the island is bare grass and brush, a boundary you can see from the water.",
  },
  {
    id: "cape-chiniak-light", name: "Cape Chiniak Light", kind: "lighthouse", lat: 57.62855, lon: -152.15332, radius: 160, model: "light", light: {color: "#ffffff",period: 6,flashes: 2}, real: { lat: 57.6281, lon: -152.1533 },
    blurb:
      "Cape Chiniak Light shows from a skeleton tower on Chiniak Island, 120 feet above the water. Its line of latitude divides the Northeast Kodiak and Eastside districts.",
  },
  {
    id: "cape-greville", name: "Cape Greville", kind: "cape", lat: 57.58998, lon: -152.15786, radius: 250, real: { lat: 57.59, lon: -152.1578 },
    blurb:
      "Two miles south of Cape Chiniak and fronted by rocky islets. The Coast Pilot warns mariners coming up from Ugak Island not to mistake it for Chiniak.",
  },
  {
    id: "narrow-cape", name: "Narrow Cape", kind: "viewpoint", lat: 57.42409, lon: -152.31744, radius: 300, onFoot: true, landing: { lat: 57.43043, lon: -152.31507 }, real: { lat: 57.4269, lon: -152.3289 },
    blurb:
      "Treeless, wind-scoured bluffs above the pass to Ugak Island. Migrating gray whales squeeze between the cape and the island in April and May and again in the fall, and Kodiak turns out on the bluff to watch them blow.",
  },
  {
    id: "pacific-spaceport", name: "Pacific Spaceport Complex", kind: "landmark", lat: 57.43761, lon: -152.33874, radius: 300, model: "spaceport", real: { lat: 57.435, lon: -152.34 },
    blurb:
      "Opened in 1998 as the Kodiak Launch Complex, the spaceport on Narrow Cape sends rockets south over open ocean toward polar orbits. Mariners are warned out of safety zones offshore during launch windows.",
  },
  {
    id: "ugak-island", name: "Ugak Island", kind: "wildlife", lat: 57.3795, lon: -152.28548, radius: 450, real: { lat: 57.3793, lon: -152.2805 },
    blurb:
      "A 1,000-foot ridge of an island 2.5 miles off Narrow Cape, ringed by kelp. Steller sea lions haul out on its rocks, tufted puffins nest in its turf, and whales feed in the pass inside it.",
  },
  {
    id: "pasagshak-river", name: "Pasagshak River", kind: "river", lat: 57.42419, lon: -152.43264, radius: 180, real: { lat: 57.4495, lon: -152.4555 },
    blurb:
      "A short river draining Lake Rose Tead into Pasagshak Bay, at the far end of the Chiniak road. Its coho run in August and September is a road-system favorite.",
  },
  {
    id: "ugak-bay", name: "Ugak Bay", kind: "bay", lat: 57.41553, lon: -152.58591, radius: 700, real: { lat: 57.4493, lon: -152.6687 },
    blurb:
      "Ugak Bay reaches 19 miles inland between Pasagshak and Gull points, branching into a basin and a narrow arm. Saltery Cove's sockeye and the pinks and chums of its head streams draw seiners in summer.",
  },
  {
    id: "kiliuda-bay", name: "Kiliuda Bay", kind: "bay", lat: 57.30817, lon: -152.94966, radius: 600, real: { lat: 57.3103, lon: -153.0464 },
    blurb:
      "A deep Eastside bay between Ugak Bay and Sitkalidak Island. Its long arms end in pink and chum streams that fill with fish in August.",
  },
  {
    id: "cape-barnabas", name: "Cape Barnabas", kind: "cape", lat: 57.15189, lon: -152.86819, radius: 300, real: { lat: 57.1519, lon: -152.8681 },
    blurb:
      "The eastern headland of Sitkalidak Island, facing the open Gulf of Alaska. Eastside boats round it bound north for Kiliuda and Ugak or south for Sitkalidak Strait.",
  },
  {
    id: "sitkalidak-strait", name: "Sitkalidak Strait", kind: "strait", lat: 57.03186, lon: -153.44931, radius: 500, real: { lat: 57.1598, lon: -153.3555 },
    blurb:
      "The winding passage between Kodiak and Sitkalidak Island that leads to Old Harbor. Currents run hard through its narrows, and pinks stage here on their way to Barling Bay.",
  },
  {
    id: "old-harbor", name: "Old Harbor", kind: "village", lat: 57.04137, lon: -153.34674, radius: 300, services: ["fuel","rest"], dock: { lat: 57.03808, lon: -153.36652, heading: 5.933 }, model: "village", church: "threeSaints", real: { lat: 57.2028, lon: -153.3057 },
    blurb:
      "Nuniaq in Alutiiq. The 1964 tsunami left only two houses and the Three Saints church standing, and the village was rebuilt on the same shore. Its parish, founded in 1795, carries the name of Shelikhov's settlement just down the coast.",
  },
  {
    id: "three-saints-bay", name: "Three Saints Bay", kind: "history", lat: 57.07941, lon: -153.47851, radius: 400, onFoot: true, landing: { lat: 57.07983, lon: -153.47456 }, real: { lat: 57.1446, lon: -153.4913 },
    blurb:
      "In August 1784 Grigory Shelikhov founded the first Russian settlement in Alaska here, naming it for his ship Three Saints. An earthquake and tsunami battered it in 1788, and Baranov moved the colony to Kodiak in 1792.",
  },
  {
    id: "awauq", name: "Awa'uq (Refuge Rock)", kind: "history", lat: 57.09684, lon: -153.08044, radius: 250, memorial: true, real: { lat: 57.1061, lon: -153.0829 },
    blurb:
      "Awa'uq means 'where one becomes numb.' In August 1784 Shelikhov's men attacked Alutiiq families who had taken refuge on this sea stack off Sitkalidak Island, killing hundreds. It is remembered as a place of mourning.",
  },
  {
    id: "kaguyak", name: "Kaguyak", kind: "history", lat: 56.86057, lon: -153.76671, radius: 280, real: { lat: 56.861, lon: -153.7667 },
    blurb:
      "Kaguyak village stood at the head of its bay until Good Friday 1964, when the fourth tsunami wave swept most of its buildings into the lake behind the beach and took two lives. Its people resettled in Akhiok and Old Harbor, and the site was never reoccupied.",
  },
  {
    id: "koniag-peak", name: "Koniag Peak", kind: "peak", lat: 57.35562, lon: -153.32662, radius: 400, real: { lat: 57.3563, lon: -153.3254 },
    blurb:
      "At 4,470 feet the highest point on Kodiak Island, holding snow into August. It is named for the Koniag, the Russian-era name for the island's Alutiiq people.",
  },
  {
    id: "akhiok", name: "Akhiok", kind: "village", lat: 56.9357, lon: -154.16931, radius: 280, model: "village", church: "akhiok", real: { lat: 56.9456, lon: -154.1736 },
    blurb:
      "Kodiak's southernmost village. Families from Aiaktalik and other settlements gathered here after the 1918 flu, and Kaguyak's survivors joined them after 1964. Its Protection of the Theotokos chapel replaced a burned Holy Trinity church in the 1910s and is on the National Register.",
  },
  {
    id: "alitak-cannery", name: "Alitak Cannery", kind: "cannery", lat: 56.88287, lon: -154.20482, radius: 260, services: ["sell","fuel","ice"], dock: { lat: 56.88287, lon: -154.15945, heading: 3.423 }, model: "cannery", real: { lat: 56.8974, lon: -154.2496 },
    blurb:
      "The Alitak Packing Company raised this Lazy Bay plant in 1917-18, and for a century it packed south-end sockeye under Pacific American Fisheries, Wards Cove and Ocean Beauty. A foot trail runs from the cannery to Akhiok.",
  },
  {
    id: "cape-alitak", name: "Cape Alitak", kind: "cape", lat: 56.84789, lon: -154.30503, radius: 300, real: { lat: 56.8475, lon: -154.3011 },
    blurb:
      "The southwest corner of Kodiak Island, where the coast turns north toward Shelikof Strait. The country here is treeless: moss, grass and bare rock on the knolls.",
  },
  {
    id: "cape-alitak-light", name: "Cape Alitak Light", kind: "lighthouse", lat: 56.84187, lon: -154.3068, radius: 160, model: "light", light: {color: "#ffffff",period: 4,flashes: 1}, real: { lat: 56.8431, lon: -154.3069 },
    blurb:
      "Cape Alitak Light, 63 feet above the water, marks the western entrance to Alitak Bay for boats running between the Southwest and Alitak districts.",
  },
  {
    id: "alitak-bay", name: "Alitak Bay", kind: "bay", lat: 56.89132, lon: -154.11211, radius: 900, real: { lat: 56.93, lon: -154.05 },
    blurb:
      "The broad bay between Cape Alitak and Cape Trinity runs 26 miles north to Deadman Bay. Olga, Moser and Deadman bays funnel sockeye through it, making the Alitak District one of Kodiak's richest seine grounds.",
  },
  {
    id: "olga-bay", name: "Olga Bay", kind: "bay", lat: 57.09526, lon: -154.40602, radius: 600, real: { lat: 57.1055, lon: -154.3 },
    blurb:
      "A long inner bay behind Alitak, reached through the crooked Olga Narrows. Sockeye bound for Frazer, Akalura and Upper Station lakes all pass through its waters.",
  },
  {
    id: "deadman-bay", name: "Deadman Bay", kind: "bay", lat: 57.00016, lon: -153.99178, radius: 500, real: { lat: 57.0599, lon: -153.949 },
    blurb:
      "The long northern arm of Alitak Bay, reaching toward the island's highest mountains. Brown bears patrol the flats where its pink and chum streams come in.",
  },
  {
    id: "dog-salmon-creek", name: "Dog Salmon Creek", kind: "river", lat: 57.05531, lon: -153.9543, radius: 220, real: { lat: 57.1322, lon: -154.0324 },
    blurb:
      "Frazer Lake's outlet. Sockeye gather on the Dog Salmon Flats before climbing a fish pass built around a 30-foot falls; ADF&G counts every one at the weir.",
  },
  {
    id: "frazer-lake", name: "Frazer Lake", kind: "lake", lat: 57.25513, lon: -154.13834, radius: 400, real: { lat: 57.2551, lon: -154.1384 },
    blurb:
      "A 30-foot falls kept salmon out of Frazer Lake until ADF&G stocked it with Karluk and Red Lake sockeye from 1951 and built a fish pass around the falls in 1962. The run it created now supports the Alitak District's seine fishery.",
  },
  {
    id: "akalura-lake", name: "Akalura Lake", kind: "lake", lat: 57.19289, lon: -154.23441, radius: 300, real: { lat: 57.1929, lon: -154.2344 },
    blurb:
      "A small sockeye and coho lake draining into Olga Bay, one of the south-end systems that feed the Alitak District's late sockeye fishery.",
  },
  {
    id: "red-lake", name: "Red Lake", kind: "lake", lat: 57.24572, lon: -154.29004, radius: 350, real: { lat: 57.2457, lon: -154.2901 },
    blurb:
      "Source of the Ayakulik River's sockeye. Red Lake eggs and fry helped seed Frazer Lake's run in the 1950s.",
  },
  {
    id: "ayakulik-river", name: "Ayakulik River", kind: "river", lat: 57.20504, lon: -154.56896, radius: 250, real: { lat: 57.2, lon: -154.55 },
    blurb:
      "Also called Red River for its sockeye. The Ayakulik's early and late runs, with big pink returns in even years, make the waters off its mouth among the Southwest District's busiest.",
  },
  {
    id: "cape-ikolik", name: "Cape Ikolik", kind: "cape", lat: 57.28567, lon: -154.79522, radius: 300, real: { lat: 57.2878, lon: -154.7858 },
    blurb:
      "A bold Shelikof Strait headland with Inner Seal Rock, a sheer 125-foot stack, just off it. Its latitude splits the Southwest District's sections.",
  },
  {
    id: "sturgeon-river", name: "Sturgeon River", kind: "river", lat: 57.47639, lon: -154.66917, radius: 200, real: { lat: 57.4468, lon: -154.4947 },
    blurb:
      "Sturgeon River drains a broad tundra valley south of Karluk and draws pinks, chums and coho; nearby Sturgeon Head marks a Southwest District section line.",
  },
  {
    id: "karluk", name: "Karluk", kind: "village", lat: 57.58079, lon: -154.46126, radius: 300, services: ["rest"], dock: { lat: 57.58998, lon: -154.4652, heading: 1.571 }, model: "village", church: "karluk", real: { lat: 57.5643, lon: -154.4365 },
    blurb:
      "The Karluk once carried the greatest red salmon run on earth, and by the 1880s canneries crowded its spit. After a 1978 storm the Alutiiq village moved up the lagoon, but the 1888 Ascension of Our Lord chapel still stands on its bluff.",
  },
  {
    id: "karluk-river", name: "Karluk River", kind: "river", lat: 57.58544, lon: -154.45041, radius: 250, real: { lat: 57.574, lon: -154.456 },
    blurb:
      "Kodiak's premier sockeye river, with an early and a late run counted past the ADF&G weir on their way to Karluk Lake, plus kings, coho, pinks and steelhead.",
  },
  {
    id: "cape-karluk", name: "Cape Karluk", kind: "cape", lat: 57.57899, lon: -154.52004, radius: 250, real: { lat: 57.5773, lon: -154.5177 },
    blurb:
      "West of Karluk village the cape shelters Karluk Anchorage, where scows and launches once moored in the roadstead through the cannery seasons.",
  },
  {
    id: "karluk-lake", name: "Karluk Lake", kind: "lake", lat: 57.35995, lon: -154.04839, radius: 450, real: { lat: 57.3599, lon: -154.0484 },
    blurb:
      "Karluk Lake feeds the archipelago's biggest sockeye run, and each summer its spawning streams draw one of the densest gatherings of brown bears anywhere.",
  },
  {
    id: "omalley-river", name: "O'Malley River", kind: "wildlife", lat: 57.30004, lon: -154.01999, radius: 300, real: { lat: 57.3, lon: -154.02 },
    blurb:
      "As many as 200 bears use the Karluk Lake country in summer, and the O'Malley, where a fifth of the lake's sockeye spawn, is the heart of it. The refuge limits visitors to a small viewing site so the bears can feed undisturbed.",
  },
  {
    id: "uyak-bay", name: "Uyak Bay", kind: "bay", lat: 57.60002, lon: -153.94996, radius: 900, real: { lat: 57.6, lon: -153.95 },
    blurb:
      "The longest bay on the Shelikof side, reaching some 30 miles inland past Larsen Bay and Amook Island. Alutiiq families have lived along its shores for thousands of years.",
  },
  {
    id: "larsen-bay", name: "Larsen Bay", kind: "village", lat: 57.54803, lon: -153.95824, radius: 260, model: "village", church: "larsen", real: { lat: 57.5366, lon: -153.9816 },
    blurb:
      "An Alutiiq village beside one of Kodiak's oldest village sites, named for fur trader and guide Peter Larsen. In 1991 the Smithsonian returned the remains of hundreds of ancestors dug up here in the 1930s, one of the first major repatriations in the U.S.",
  },
  {
    id: "larsen-bay-cannery", name: "Larsen Bay Cannery", kind: "cannery", lat: 57.56652, lon: -153.96909, radius: 220, services: ["sell","fuel","ice"], dock: { lat: 57.56652, lon: -153.95331, heading: 3.142 }, model: "cannery", real: { lat: 57.543, lon: -153.97 },
    blurb:
      "The Alaska Packers Association built this cannery in 1911 to pack Karluk River reds, on the spit between Larsen Bay and Uyak Bay. From the bay's head a trail crosses a low divide to the Karluk River.",
  },
  {
    id: "spiridon-bay", name: "Spiridon Bay", kind: "bay", lat: 57.678, lon: -153.86435, radius: 450, real: { lat: 57.66, lon: -153.75 },
    blurb:
      "A waterfall keeps wild sockeye out of Spiridon Lake, so the aquaculture association stocks it with fry. The adults return to Telrod Cove, where seiners harvest them in a special harvest area.",
  },
  {
    id: "cape-kuliuk", name: "Cape Kuliuk", kind: "cape", lat: 57.80565, lon: -153.94089, radius: 250, real: { lat: 57.8044, lon: -153.9306 },
    blurb:
      "A Shelikof headland near the mouth of Uyak Bay, looking across the strait to the Katmai coast and its volcanoes.",
  },
  {
    id: "cape-ugat", name: "Cape Ugat", kind: "cape", lat: 57.87211, lon: -153.85291, radius: 250, real: { lat: 57.87, lon: -153.8481 },
    blurb:
      "A steep Shelikof Strait headland between Uganik and Uyak bays; boats rounding it meet the full sweep of the strait's tide rips.",
  },
  {
    id: "uganik-bay", name: "Uganik Bay", kind: "bay", lat: 57.87496, lon: -153.55011, radius: 800, real: { lat: 57.8348, lon: -153.5323 },
    blurb:
      "A many-armed bay on the Shelikof side. The Alaska Packers packed salmon here as early as 1896, and set-netters still work its beaches every summer.",
  },
  {
    id: "uganik-cannery", name: "Port O'Brien Cannery", kind: "cannery", lat: 57.88563, lon: -153.49271, radius: 240, services: ["sell","ice"], dock: { lat: 57.88563, lon: -153.5154, heading: 5.582 }, model: "cannery", real: { lat: 57.7308, lon: -153.3198 },
    blurb:
      "The San Juan Fishing and Packing Company built this cannery in Uganik Bay's Northeast Arm in 1926 and named it for longtime hand Bertram O'Brien. It packed salmon from a fish trap, beach seines and gillnets until 1984; a caretaker keeps it now.",
  },
  {
    id: "uganik-river", name: "Uganik River", kind: "river", lat: 57.75979, lon: -153.49646, radius: 200, real: { lat: 57.6908, lon: -153.434 },
    blurb:
      "Uganik River drains Uganik Lake into the head of the bay, with sockeye, pinks and coho.",
  },
  {
    id: "cape-uganik", name: "Cape Uganik", kind: "cape", lat: 57.9689, lon: -153.51145, radius: 280, real: { lat: 57.9664, lon: -153.5052 },
    blurb:
      "Kodiak's northwest corner, rounded by boats bound out of Kupreanof Strait into Uganik Bay and Shelikof Strait.",
  },
  {
    id: "viekoda-bay", name: "Viekoda Bay", kind: "bay", lat: 57.93001, lon: -153.27178, radius: 450, real: { lat: 57.9019, lon: -153.2163 },
    blurb:
      "An arm of the Northwest District off Kupreanof Strait, with alder slopes and pink salmon streams at its head.",
  },
  {
    id: "shelikof-strait", name: "Shelikof Strait", kind: "strait", lat: 57.94998, lon: -154.20008, radius: 1500, real: { lat: 57.95, lon: -154.2 },
    blurb:
      "The strait between Kodiak and the Alaska Peninsula. On June 6, 1912, Novarupta erupted across it, the century's largest eruption, burying Kodiak under a foot of ash and plunging the town into darkness for about 60 hours.",
  },
  {
    id: "kupreanof-strait", name: "Kupreanof Strait", kind: "strait", lat: 57.9987, lon: -153.17315, radius: 600, real: { lat: 57.97, lon: -153.05 },
    blurb:
      "The passage between Kodiak and Afognak's Raspberry Island. The old Port Bailey cannery on Dry Spruce Bay now serves as a lodge.",
  },
  {
    id: "port-lions", name: "Port Lions", kind: "village", lat: 57.88239, lon: -152.81406, radius: 300, services: ["fuel","rest"], dock: { lat: 57.88239, lon: -152.7825, heading: -1.571 }, model: "village", church: "portLions", real: { lat: 57.8676, lon: -152.8831 },
    blurb:
      "Settled in 1964-65 by the people of Afognak village after the Good Friday tsunami ruined their homes, and named for the Lions Club, which helped them rebuild at Settler Cove.",
  },
  {
    id: "kizhuyak-bay", name: "Kizhuyak Bay", kind: "bay", lat: 57.89588, lon: -152.72103, radius: 600, real: { lat: 57.86, lon: -152.8 },
    blurb:
      "The continuation of Marmot Bay, running 14 miles south into Kodiak Island. It shelters Port Lions, and the Terror Lake powerhouse sits near its head.",
  },
  {
    id: "ouzinkie", name: "Ouzinkie", kind: "village", lat: 57.9353, lon: -152.5005, radius: 280, services: ["rest"], dock: { lat: 57.94269, lon: -152.53206, heading: 0.461 }, model: "village", church: "ouzinkie", real: { lat: 57.9235, lon: -152.502 },
    blurb:
      "Founded in the early 1800s as a retirement settlement for Russian-American Company workers, Ouzinkie takes its name from the Russian for 'narrow', after Narrow Strait. The 1964 tsunami carried away its cannery; its blue-domed Nativity of Our Lord church still overlooks the harbor.",
  },
  {
    id: "monks-lagoon", name: "Monks' Lagoon", kind: "history", lat: 57.94364, lon: -152.41429, radius: 220, onFoot: true, landing: { lat: 57.94411, lon: -152.41027 }, real: { lat: 57.942, lon: -152.43 },
    blurb:
      "St. Herman lived here on Spruce Island as a hermit until his death in 1837, teaching and caring for Alutiiq orphans. In 1970 he became the first Orthodox saint canonized in America, and pilgrims come by boat every August.",
  },
  {
    id: "marmot-bay", name: "Marmot Bay", kind: "bay", lat: 57.99996, lon: -152.20007, radius: 1100, real: { lat: 58, lon: -152.2 },
    blurb:
      "The wide bay between Kodiak and Afognak islands, the fleet's road from Kodiak to Kupreanof Strait and Whale Pass. Tufted puffins and murres work its tide lines.",
  },
  {
    id: "marmot-island", name: "Marmot Island Rookery", kind: "wildlife", lat: 58.20263, lon: -151.85743, radius: 700, real: { lat: 58.2166, lon: -151.8442 },
    blurb:
      "The southeast shore of Marmot Island is a Steller sea lion rookery, once among the largest in the Gulf of Alaska. A federal 3-mile no-approach zone surrounds it; watch the colony through binoculars from outside.",
  },
  {
    id: "izhut-bay", name: "Izhut Bay", kind: "bay", lat: 58.15719, lon: -152.25589, radius: 450, real: { lat: 58.19, lon: -152.25 },
    blurb:
      "A north arm of Marmot Bay, five miles wide between Pillar Cape and Peril Cape, exposed to the south. Its western arm, Kitoi Bay, is a landlocked basin holding the hatchery.",
  },
  {
    id: "kitoi-bay-hatchery", name: "Kitoi Bay Hatchery", kind: "hatchery", lat: 58.18868, lon: -152.28706, radius: 260, dock: { lat: 58.18178, lon: -152.26604, heading: 3.196 }, model: "hatchery", real: { lat: 58.1918, lon: -152.3721 },
    blurb:
      "The Fish and Wildlife Service built Kitoi Bay in 1954 as a sockeye research station; the 1964 tsunami wrecked it and the state rebuilt it the next year. Run by the aquaculture association, it now turns out pinks, chums, coho and sockeye, and its pinks pour back into Izhut Bay in late summer.",
  },
  {
    id: "kazakof-bay", name: "Kazakof Bay", kind: "bay", lat: 58.07657, lon: -152.58413, radius: 450, real: { lat: 58.1442, lon: -152.5822 },
    blurb:
      "A sheltered bay on Afognak Island's south shore, ringed by Sitka spruce, with pink and coho streams at its head.",
  },
  {
    id: "afognak-village", name: "Afognak Village Site", kind: "history", lat: 58.0063, lon: -152.75753, radius: 280, onFoot: true, landing: { lat: 57.98733, lon: -152.72521 }, real: { lat: 58.0072, lon: -152.7694 },
    blurb:
      "For generations Afognak was one of the archipelago's largest Alutiiq villages. The 1964 earthquake dropped its shore and the tsunami flooded it; its people moved to found Port Lions, and the tribe carries the name on.",
  },
  {
    id: "afognak-island", name: "Afognak Island", kind: "island", lat: 58.23602, lon: -152.60426, radius: 1500, real: { lat: 58.236, lon: -152.6043 },
    blurb:
      "In 1892 President Benjamin Harrison set Afognak aside as a forest and fish-culture reserve, one of the nation's first. Its Sitka spruce forests, salmon lakes and elk range are now partly a state park.",
  },
];

export const STREAMS = [
{ id: "karluk", name: "Karluk River", lat: 57.58544, lon: -154.45041, species: ["sockeye","pink","coho","king"], closedRadius: 350, placeId: "karluk-river" },
  { id: "ayakulik", name: "Ayakulik River", lat: 57.20504, lon: -154.56896, species: ["sockeye","pink","coho","king"], closedRadius: 300, placeId: "ayakulik-river" },
  { id: "sturgeon", name: "Sturgeon River", lat: 57.47639, lon: -154.66917, species: ["pink","chum","coho"], closedRadius: 200, placeId: "sturgeon-river" },
  { id: "dog-salmon", name: "Dog Salmon Creek", lat: 57.05531, lon: -153.9543, species: ["sockeye","pink","coho"], closedRadius: 250, placeId: "dog-salmon-creek" },
  { id: "akalura", name: "Akalura Creek", lat: 56.99065, lon: -154.04701, species: ["sockeye","coho"], closedRadius: 200 },
  { id: "upper-station", name: "Upper Station", lat: 56.95683, lon: -154.12197, species: ["sockeye","pink"], closedRadius: 250 },
  { id: "deadman", name: "Deadman Bay Creek", lat: 57.0569, lon: -153.95213, species: ["pink","chum"], closedRadius: 150 },
  { id: "uganik", name: "Uganik River", lat: 57.75979, lon: -153.49646, species: ["sockeye","pink","coho"], closedRadius: 250, placeId: "uganik-river" },
  { id: "telrod", name: "Telrod Creek", lat: 57.6743, lon: -153.76671, species: ["sockeye"], closedRadius: 150 },
  { id: "zachar", name: "Zachar River", lat: 57.57942, lon: -153.83949, species: ["pink","chum"], closedRadius: 200 },
  { id: "kizhuyak", name: "Kizhuyak River", lat: 57.88162, lon: -152.70742, species: ["pink","chum"], closedRadius: 200 },
  { id: "afognak", name: "Afognak River", lat: 58.02744, lon: -152.74549, species: ["sockeye","pink","coho"], closedRadius: 250 },
  { id: "kitoi", name: "Kitoi Creek", lat: 58.18171, lon: -152.28114, species: ["pink","chum","coho"], closedRadius: 150 },
  { id: "buskin", name: "Buskin River", lat: 57.75672, lon: -152.46006, species: ["sockeye","coho","pink"], closedRadius: 200, placeId: "buskin-river" },
  { id: "american", name: "American River", lat: 57.65433, lon: -152.40956, species: ["pink","coho","chum"], closedRadius: 150 },
  { id: "olds", name: "Olds River", lat: 57.6127, lon: -152.40798, species: ["pink","coho"], closedRadius: 150 },
  { id: "saltery", name: "Saltery River", lat: 57.45558, lon: -152.70328, species: ["sockeye","coho","pink"], closedRadius: 200 },
  { id: "pasagshak", name: "Pasagshak River", lat: 57.42419, lon: -152.43264, species: ["coho","sockeye","pink"], closedRadius: 200, placeId: "pasagshak-river" },
  { id: "barling", name: "Barling Bay Creek", lat: 57.12114, lon: -153.41262, species: ["pink","chum"], closedRadius: 150 },
];

export const DISTRICTS = [
{
    id: "afognak",
    name: "Afognak",
    label: { lat: 58.1, lon: -152.2 },
    polygon: [{ lat: 58.6, lon: -153.2 }, { lat: 58.6, lon: -151.7 }, { lat: 57.986, lon: -151.7 }, { lat: 57.986, lon: -153.15 }, { lat: 58.06, lon: -153.15 }, { lat: 58.06, lon: -153.93 }, { lat: 58.071, lon: -153.909 }, { lat: 58.155, lon: -153.759 }, { lat: 58.24, lon: -153.649 }, { lat: 58.324, lon: -153.554 }, { lat: 58.409, lon: -153.443 }, { lat: 58.5, lon: -153.31 }],
  },
  {
    id: "northwest",
    name: "Northwest Kodiak",
    label: { lat: 57.90438, lon: -153.7934 },
    polygon: [{ lat: 58.06, lon: -153.93 }, { lat: 58.06, lon: -153.15 }, { lat: 57.986, lon: -153.15 }, { lat: 57.986, lon: -151.7 }, { lat: 57.856, lon: -151.7 }, { lat: 57.856, lon: -152.4 }, { lat: 57.78, lon: -152.62 }, { lat: 57.7, lon: -152.85 }, { lat: 57.663, lon: -153.1 }, { lat: 57.62, lon: -153.2 }, { lat: 57.43, lon: -153.6 }, { lat: 57.43, lon: -154.02 }, { lat: 57.663, lon: -154.2 }, { lat: 57.663, lon: -154.93 }, { lat: 57.732, lon: -154.73 }, { lat: 57.817, lon: -154.485 }, { lat: 57.901, lon: -154.225 }, { lat: 57.986, lon: -154.067 }],
  },
  {
    id: "southwest",
    name: "Southwest Kodiak",
    label: { lat: 57.43691, lon: -154.76992 },
    polygon: [{ lat: 57.663, lon: -154.93 }, { lat: 57.663, lon: -154.2 }, { lat: 57.43, lon: -154.02 }, { lat: 57.43, lon: -153.6 }, { lat: 57.62, lon: -153.2 }, { lat: 57.4, lon: -153.5 }, { lat: 57.2, lon: -153.75 }, { lat: 56.9917, lon: -153.93 }, { lat: 56.9917, lon: -155.1 }, { lat: 57.6, lon: -155.1 }, { lat: 57.648, lon: -154.974 }],
  },
  {
    id: "alitak",
    name: "Alitak",
    label: { lat: 56.93, lon: -154.1 },
    polygon: [{ lat: 56.9917, lon: -155.1 }, { lat: 56.9917, lon: -153.93 }, { lat: 56.7, lon: -153.95 }, { lat: 56.7, lon: -155.1 }],
  },
  {
    id: "eastside",
    name: "Eastside Kodiak",
    label: { lat: 57.25773, lon: -152.74211 },
    polygon: [{ lat: 57.62, lon: -151.7 }, { lat: 56.7, lon: -151.7 }, { lat: 56.7, lon: -153.95 }, { lat: 56.9917, lon: -153.93 }, { lat: 57.2, lon: -153.75 }, { lat: 57.4, lon: -153.5 }, { lat: 57.62, lon: -153.2 }],
  },
  {
    id: "northeast",
    name: "Northeast Kodiak",
    label: { lat: 57.72577, lon: -152.3 },
    polygon: [{ lat: 57.856, lon: -152.4 }, { lat: 57.856, lon: -151.7 }, { lat: 57.62, lon: -151.7 }, { lat: 57.62, lon: -153.2 }, { lat: 57.663, lon: -153.1 }, { lat: 57.7, lon: -152.85 }, { lat: 57.78, lon: -152.62 }],
  },
  {
    id: "mainland",
    name: "Mainland",
    label: { lat: 58.17041, lon: -154.13688 },
    polygon: [{ lat: 58.6, lon: -155.1 }, { lat: 58.6, lon: -153.2 }, { lat: 58.5, lon: -153.31 }, { lat: 58.409, lon: -153.443 }, { lat: 58.324, lon: -153.554 }, { lat: 58.24, lon: -153.649 }, { lat: 58.155, lon: -153.759 }, { lat: 58.071, lon: -153.909 }, { lat: 57.986, lon: -154.067 }, { lat: 57.901, lon: -154.225 }, { lat: 57.817, lon: -154.485 }, { lat: 57.732, lon: -154.73 }, { lat: 57.648, lon: -154.974 }, { lat: 57.6, lon: -155.1 }, { lat: 57.6, lon: -155.1 }],
  },
];

export const FOOTPRINTS = [
  { id: 'cape-karluk-1', lat: 57.4624, lon: -154.6988, radius: 4 },
  { id: 'cape-karluk-2', lat: 57.49682, lon: -154.65852, radius: 4 },
  { id: 'cape-ikolik-1', lat: 57.23506, lon: -154.59114, radius: 4 },
  { id: 'cape-ikolik-2', lat: 57.17617, lon: -154.5397, radius: 4 },
  { id: 'cape-karluk-3', lat: 57.58098, lon: -154.51883, radius: 4 },
  { id: 'karluk-1', lat: 57.58074, lon: -154.46883, radius: 28 },
  { id: 'karluk-2', lat: 57.58198, lon: -154.46142, radius: 31 },
  { id: 'karluk-3', lat: 57.57848, lon: -154.45759, radius: 10 },
  { id: 'karluk-4', lat: 57.58363, lon: -154.45597, radius: 10 },
  { id: 'karluk-5', lat: 57.5786, lon: -154.45416, radius: 10 },
  { id: 'karluk-6', lat: 57.58138, lon: -154.45389, radius: 23 },
  { id: 'karluk-7', lat: 57.61342, lon: -154.40522, radius: 4 },
  { id: 'cape-alitak-light-1', lat: 56.84293, lon: -154.30361, radius: 9 },
  { id: 'alitak-cannery-1', lat: 56.89136, lon: -154.20968, radius: 23 },
  { id: 'alitak-cannery-2', lat: 56.88842, lon: -154.20967, radius: 21 },
  { id: 'alitak-cannery-3', lat: 56.8911, lon: -154.2033, radius: 40 },
  { id: 'alitak-cannery-4', lat: 56.89444, lon: -154.20166, radius: 10 },
  { id: 'alitak-cannery-5', lat: 56.88791, lon: -154.20016, radius: 26 },
  { id: 'alitak-cannery-6', lat: 56.89048, lon: -154.19582, radius: 14 },
  { id: 'akhiok-1', lat: 56.93863, lon: -154.17701, radius: 25 },
  { id: 'akhiok-2', lat: 56.93099, lon: -154.17545, radius: 18 },
  { id: 'akhiok-3', lat: 56.9344, lon: -154.1744, radius: 30 },
  { id: 'akhiok-4', lat: 56.93524, lon: -154.17164, radius: 9 },
  { id: 'akhiok-5', lat: 56.93912, lon: -154.1689, radius: 33 },
  { id: 'akhiok-6', lat: 56.94152, lon: -154.16666, radius: 9 },
  { id: 'akhiok-7', lat: 56.94117, lon: -154.16312, radius: 10 },
  { id: 'akhiok-8', lat: 56.93415, lon: -154.14983, radius: 4 },
  { id: 'akhiok-9', lat: 56.95906, lon: -154.07209, radius: 4 },
  { id: 'akhiok-10', lat: 56.96824, lon: -154.04795, radius: 4 },
  { id: 'akhiok-11', lat: 57.00111, lon: -154.01292, radius: 4 },
  { id: 'larsen-bay-cannery-1', lat: 57.56385, lon: -153.97114, radius: 10 },
  { id: 'larsen-bay-cannery-2', lat: 57.56685, lon: -153.97032, radius: 33 },
  { id: 'larsen-bay-cannery-3', lat: 57.57051, lon: -153.96593, radius: 13 },
  { id: 'larsen-bay-cannery-4', lat: 57.56697, lon: -153.9638, radius: 43 },
  { id: 'larsen-bay-1', lat: 57.552, lon: -153.96249, radius: 32 },
  { id: 'larsen-bay-2', lat: 57.54737, lon: -153.96152, radius: 23 },
  { id: 'larsen-bay-cannery-5', lat: 57.56818, lon: -153.95849, radius: 13 },
  { id: 'larsen-bay-3', lat: 57.54519, lon: -153.95827, radius: 9 },
  { id: 'larsen-bay-4', lat: 57.54759, lon: -153.95583, radius: 30 },
  { id: 'larsen-bay-5', lat: 57.55212, lon: -153.95445, radius: 39 },
  { id: 'larsen-bay-6', lat: 57.55138, lon: -153.9483, radius: 10 },
  { id: 'larsen-bay-7', lat: 57.54828, lon: -153.94803, radius: 24 },
  { id: 'akhiok-12', lat: 57.04369, lon: -153.93578, radius: 4 },
  { id: 'akhiok-13', lat: 57.04814, lon: -153.92747, radius: 4 },
  { id: 'akhiok-14', lat: 57.03408, lon: -153.92496, radius: 4 },
  { id: 'akhiok-15', lat: 57.04188, lon: -153.91184, radius: 4 },
  { id: 'larsen-bay-8', lat: 57.56171, lon: -153.86108, radius: 4 },
  { id: 'larsen-bay-cannery-6', lat: 57.60038, lon: -153.84453, radius: 4 },
  { id: 'larsen-bay-cannery-7', lat: 57.68027, lon: -153.7941, radius: 4 },
  { id: 'larsen-bay-cannery-8', lat: 57.66254, lon: -153.78285, radius: 4 },
  { id: 'uganik-cannery-1', lat: 57.76954, lon: -153.54229, radius: 4 },
  { id: 'uganik-cannery-2', lat: 57.89079, lon: -153.50704, radius: 23 },
  { id: 'uganik-cannery-3', lat: 57.88984, lon: -153.50148, radius: 43 },
  { id: 'uganik-cannery-4', lat: 57.89396, lon: -153.50051, radius: 25 },
  { id: 'uganik-cannery-5', lat: 57.78679, lon: -153.49843, radius: 4 },
  { id: 'uganik-cannery-6', lat: 57.88929, lon: -153.49617, radius: 31 },
  { id: 'uganik-cannery-7', lat: 57.89389, lon: -153.49556, radius: 21 },
  { id: 'three-saints-bay-1', lat: 57.11017, lon: -153.39127, radius: 4 },
  { id: 'three-saints-bay-2', lat: 57.11549, lon: -153.38498, radius: 4 },
  { id: 'old-harbor-1', lat: 57.04412, lon: -153.35673, radius: 19 },
  { id: 'old-harbor-2', lat: 57.04669, lon: -153.35598, radius: 9 },
  { id: 'old-harbor-3', lat: 57.03763, lon: -153.35573, radius: 9 },
  { id: 'old-harbor-4', lat: 57.04353, lon: -153.35222, radius: 32 },
  { id: 'old-harbor-5', lat: 57.03944, lon: -153.3522, radius: 35 },
  { id: 'old-harbor-6', lat: 57.04625, lon: -153.3505, radius: 25 },
  { id: 'old-harbor-7', lat: 57.03548, lon: -153.34897, radius: 23 },
  { id: 'old-harbor-8', lat: 57.03512, lon: -153.34578, radius: 10 },
  { id: 'old-harbor-9', lat: 57.04366, lon: -153.34476, radius: 22 },
  { id: 'old-harbor-10', lat: 57.03905, lon: -153.34409, radius: 39 },
  { id: 'port-lions-1', lat: 57.87799, lon: -152.82629, radius: 9 },
  { id: 'port-lions-2', lat: 57.88029, lon: -152.82589, radius: 33 },
  { id: 'port-lions-3', lat: 57.88387, lon: -152.82428, radius: 9 },
  { id: 'port-lions-4', lat: 57.88096, lon: -152.8187, radius: 30 },
  { id: 'port-lions-5', lat: 57.88542, lon: -152.8175, radius: 33 },
  { id: 'port-lions-6', lat: 57.88097, lon: -152.81244, radius: 18 },
  { id: 'port-lions-7', lat: 57.88524, lon: -152.80915, radius: 37 },
  { id: 'port-lions-8', lat: 57.88552, lon: -152.80375, radius: 28 },
  { id: 'port-lions-9', lat: 57.88847, lon: -152.8023, radius: 21 },
  { id: 'afognak-village-1', lat: 58.00199, lon: -152.75539, radius: 4 },
  { id: 'pacific-spaceport-1', lat: 57.45268, lon: -152.74236, radius: 4 },
  { id: 'pacific-spaceport-2', lat: 57.44476, lon: -152.73717, radius: 4 },
  { id: 'port-lions-10', lat: 57.86378, lon: -152.7301, radius: 4 },
  { id: 'afognak-village-2', lat: 58.04199, lon: -152.70509, radius: 4 },
  { id: 'port-lions-11', lat: 57.88412, lon: -152.66581, radius: 4 },
  { id: 'ouzinkie-1', lat: 57.93304, lon: -152.50691, radius: 33 },
  { id: 'ouzinkie-2', lat: 57.93917, lon: -152.50648, radius: 9 },
  { id: 'uscg-base-1', lat: 57.73428, lon: -152.50516, radius: 5 },
  { id: 'ouzinkie-3', lat: 57.94118, lon: -152.50514, radius: 19 },
  { id: 'ouzinkie-4', lat: 57.93393, lon: -152.50049, radius: 33 },
  { id: 'ouzinkie-5', lat: 57.9409, lon: -152.49957, radius: 31 },
  { id: 'uscg-base-2', lat: 57.73011, lon: -152.49911, radius: 20 },
  { id: 'ouzinkie-6', lat: 57.93764, lon: -152.49864, radius: 40 },
  { id: 'uscg-base-3', lat: 57.73752, lon: -152.49738, radius: 27 },
  { id: 'uscg-base-4', lat: 57.73948, lon: -152.49152, radius: 23 },
  { id: 'uscg-base-5', lat: 57.73282, lon: -152.4913, radius: 33 },
  { id: 'uscg-base-6', lat: 57.72701, lon: -152.49112, radius: 33 },
  { id: 'uscg-base-7', lat: 57.73869, lon: -152.48558, radius: 25 },
  { id: 'uscg-base-8', lat: 57.73005, lon: -152.48293, radius: 34 },
  { id: 'uscg-base-9', lat: 57.74178, lon: -152.48252, radius: 16 },
  { id: 'uscg-base-10', lat: 57.73672, lon: -152.47653, radius: 4 },
  { id: 'pacific-spaceport-3', lat: 57.41696, lon: -152.47014, radius: 4 },
  { id: 'pillar-mountain-1', lat: 57.78637, lon: -152.45093, radius: 12 },
  { id: 'st-paul-harbor-light-1', lat: 57.72686, lon: -152.44532, radius: 9 },
  { id: 'pillar-mountain-2', lat: 57.78756, lon: -152.44398, radius: 12 },
  { id: 'pillar-mountain-3', lat: 57.78904, lon: -152.4373, radius: 12 },
  { id: 'pillar-mountain-4', lat: 57.77125, lon: -152.43679, radius: 33 },
  { id: 'pillar-creek-hatchery-1', lat: 57.80337, lon: -152.43654, radius: 31 },
  { id: 'pillar-mountain-5', lat: 57.78055, lon: -152.4365, radius: 10 },
  { id: 'pillar-mountain-6', lat: 57.77573, lon: -152.43644, radius: 38 },
  { id: 'st-paul-harbor-1', lat: 57.76253, lon: -152.43622, radius: 27 },
  { id: 'kodiak-1', lat: 57.76745, lon: -152.43477, radius: 25 },
  { id: 'st-paul-harbor-2', lat: 57.76202, lon: -152.42851, radius: 30 },
  { id: 'kodiak-2', lat: 57.77114, lon: -152.42846, radius: 36 },
  { id: 'pillar-mountain-7', lat: 57.7807, lon: -152.42844, radius: 33 },
  { id: 'holy-resurrection-1', lat: 57.77606, lon: -152.42798, radius: 37 },
  { id: 'pillar-mountain-8', lat: 57.79168, lon: -152.42768, radius: 31 },
  { id: 'st-paul-harbor-3', lat: 57.7671, lon: -152.42766, radius: 41 },
  { id: 'pillar-creek-hatchery-2', lat: 57.80357, lon: -152.42681, radius: 17 },
  { id: 'pillar-mountain-9', lat: 57.78381, lon: -152.42654, radius: 24 },
  { id: 'st-paul-harbor-4', lat: 57.75852, lon: -152.42622, radius: 13 },
  { id: 'st-paul-harbor-5', lat: 57.76124, lon: -152.42131, radius: 27 },
  { id: 'pillar-creek-hatchery-3', lat: 57.79602, lon: -152.41969, radius: 12 },
  { id: 'st-paul-harbor-6', lat: 57.76667, lon: -152.41965, radius: 34 },
  { id: 'kodiak-3', lat: 57.77147, lon: -152.41959, radius: 38 },
  { id: 'holy-resurrection-2', lat: 57.78074, lon: -152.41912, radius: 34 },
  { id: 'kodiak-4', lat: 57.77566, lon: -152.41897, radius: 33 },
  { id: 'holy-resurrection-3', lat: 57.78441, lon: -152.41736, radius: 19 },
  { id: 'st-paul-harbor-light-2', lat: 57.63954, lon: -152.4173, radius: 4 },
  { id: 'st-paul-harbor-light-3', lat: 57.62852, lon: -152.41203, radius: 4 },
  { id: 'holy-resurrection-4', lat: 57.78109, lon: -152.41113, radius: 40 },
  { id: 'kodiak-5', lat: 57.77141, lon: -152.41021, radius: 38 },
  { id: 'kodiak-6', lat: 57.77605, lon: -152.4099, radius: 28 },
  { id: 'st-paul-harbor-7', lat: 57.76606, lon: -152.40782, radius: 30 },
  { id: 'holy-resurrection-5', lat: 57.79154, lon: -152.40656, radius: 20 },
  { id: 'holy-resurrection-6', lat: 57.79376, lon: -152.40593, radius: 10 },
  { id: 'kodiak-7', lat: 57.77603, lon: -152.4043, radius: 18 },
  { id: 'kodiak-8', lat: 57.7736, lon: -152.40394, radius: 9 },
  { id: 'cannery-row-1', lat: 57.76723, lon: -152.40125, radius: 44 },
  { id: 'holy-resurrection-7', lat: 57.78615, lon: -152.40112, radius: 38 },
  { id: 'kodiak-9', lat: 57.78293, lon: -152.40087, radius: 9 },
  { id: 'holy-resurrection-8', lat: 57.79048, lon: -152.40083, radius: 36 },
  { id: 'holy-resurrection-9', lat: 57.79524, lon: -152.40058, radius: 32 },
  { id: 'holy-resurrection-10', lat: 57.79907, lon: -152.39721, radius: 9 },
  { id: 'st-paul-harbor-light-4', lat: 57.66837, lon: -152.39591, radius: 4 },
  { id: 'pacific-spaceport-4', lat: 57.42388, lon: -152.39441, radius: 4 },
  { id: 'cannery-row-2', lat: 57.77019, lon: -152.3937, radius: 37 },
  { id: 'cannery-row-3', lat: 57.77493, lon: -152.3934, radius: 32 },
  { id: 'kodiak-10', lat: 57.78219, lon: -152.39323, radius: 29 },
  { id: 'cannery-row-4', lat: 57.76603, lon: -152.39265, radius: 38 },
  { id: 'holy-resurrection-11', lat: 57.79039, lon: -152.39249, radius: 39 },
  { id: 'holy-resurrection-12', lat: 57.79517, lon: -152.39218, radius: 32 },
  { id: 'kodiak-11', lat: 57.78573, lon: -152.39212, radius: 35 },
  { id: 'holy-resurrection-13', lat: 57.79891, lon: -152.39199, radius: 31 },
  { id: 'st-paul-harbor-light-5', lat: 57.62471, lon: -152.38867, radius: 4 },
  { id: 'cannery-row-5', lat: 57.77191, lon: -152.38609, radius: 29 },
  { id: 'holy-resurrection-14', lat: 57.79841, lon: -152.38462, radius: 28 },
  { id: 'kodiak-12', lat: 57.78205, lon: -152.3844, radius: 25 },
  { id: 'holy-resurrection-15', lat: 57.79492, lon: -152.38408, radius: 32 },
  { id: 'kodiak-13', lat: 57.78499, lon: -152.38343, radius: 33 },
  { id: 'holy-resurrection-16', lat: 57.79058, lon: -152.38284, radius: 35 },
  { id: 'kodiak-14', lat: 57.78587, lon: -152.37687, radius: 29 },
  { id: 'holy-resurrection-17', lat: 57.79467, lon: -152.37674, radius: 34 },
  { id: 'kodiak-15', lat: 57.78996, lon: -152.37612, radius: 27 },
  { id: 'st-herman-harbor-1', lat: 57.77556, lon: -152.36234, radius: 21 },
  { id: 'fort-abercrombie-1', lat: 57.83729, lon: -152.36229, radius: 20 },
  { id: 'st-herman-harbor-2', lat: 57.76984, lon: -152.36058, radius: 16 },
  { id: 'st-herman-harbor-3', lat: 57.76786, lon: -152.35689, radius: 37 },
  { id: 'fort-abercrombie-2', lat: 57.83781, lon: -152.35523, radius: 20 },
  { id: 'spruce-cape-1', lat: 57.80005, lon: -152.35492, radius: 32 },
  { id: 'spruce-cape-2', lat: 57.80399, lon: -152.35432, radius: 19 },
  { id: 'spruce-cape-3', lat: 57.79656, lon: -152.35385, radius: 18 },
  { id: 'spruce-cape-4', lat: 57.80017, lon: -152.34826, radius: 34 },
  { id: 'spruce-cape-5', lat: 57.79528, lon: -152.34801, radius: 32 },
  { id: 'fort-abercrombie-3', lat: 57.83554, lon: -152.34758, radius: 20 },
  { id: 'spruce-cape-6', lat: 57.80698, lon: -152.34733, radius: 10 },
  { id: 'spruce-cape-7', lat: 57.80435, lon: -152.34697, radius: 35 },
  { id: 'pacific-spaceport-5', lat: 57.45303, lon: -152.34661, radius: 14 },
  { id: 'st-herman-harbor-4', lat: 57.77257, lon: -152.34644, radius: 47 },
  { id: 'pacific-spaceport-6', lat: 57.44726, lon: -152.34638, radius: 25 },
  { id: 'spruce-cape-8', lat: 57.79559, lon: -152.34028, radius: 28 },
  { id: 'pacific-spaceport-7', lat: 57.45127, lon: -152.34004, radius: 5 },
  { id: 'spruce-cape-9', lat: 57.79943, lon: -152.33964, radius: 35 },
  { id: 'spruce-cape-10', lat: 57.80366, lon: -152.3391, radius: 30 },
  { id: 'pacific-spaceport-8', lat: 57.44823, lon: -152.33808, radius: 30 },
  { id: 'spruce-cape-11', lat: 57.79963, lon: -152.33465, radius: 9 },
  { id: 'spruce-cape-12', lat: 57.79699, lon: -152.33453, radius: 9 },
  { id: 'pacific-spaceport-9', lat: 57.45229, lon: -152.32877, radius: 5 },
  { id: 'pacific-spaceport-10', lat: 57.44824, lon: -152.32855, radius: 57 },
  { id: 'hanin-rock-light-1', lat: 57.82532, lon: -152.32739, radius: 9 },
  { id: 'pacific-spaceport-11', lat: 57.44688, lon: -152.32465, radius: 6 },
  { id: 'woody-island-light-1', lat: 57.76535, lon: -152.30635, radius: 9 },
  { id: 'kitoi-bay-hatchery-1', lat: 58.18542, lon: -152.2912, radius: 17 },
  { id: 'kitoi-bay-hatchery-2', lat: 58.18989, lon: -152.28614, radius: 31 },
  { id: 'kitoi-bay-hatchery-3', lat: 58.16614, lon: -152.28513, radius: 4 },
  { id: 'kitoi-bay-hatchery-4', lat: 58.19755, lon: -152.27864, radius: 4 },
  { id: 'cape-chiniak-light-1', lat: 57.62865, lon: -152.15266, radius: 9 },
];

export const CLOSED_AREAS = [
  {
    id: 'marmot-rookery',
    name: 'Marmot Island sea lion rookery',
    lat: 58.20474,
    lon: -151.84165,
    radius: 470,
    reason: 'Steller sea lion rookery: federal 3-nautical-mile no-approach zone (50 CFR 224.103)',
    placeId: 'marmot-island',
  },
];

// New-game spawn in the St. Paul Harbor approaches (open water, heading in degrees clockwise from north).
export const SPAWN = { lat: 57.74193, lon: -152.38017, heading: 345 };

// Resolves lat/lon to world coordinates with ctx.geo (or createGeo(config.world.half)).
// → { places: [{ ...p, x, z, dock?: { x, z, heading }, landing?: { x, z } }], streams: [{ ...s, x, z }],
//     districts: [{ ...d, label: { x, z }, polygon: [{ x, z }] }], footprints: [{ ...f, x, z }],
//     closedAreas: [{ ...c, x, z }] }
export function resolve(geo) {
  const at = (o) => ({ ...o, ...geo.toWorld(o.lat, o.lon) });
  const districts = DISTRICTS.map((d) => ({
    ...d,
    label: geo.toWorld(d.label.lat, d.label.lon),
    polygon: (d.polygon ?? []).map((q) => geo.toWorld(q.lat, q.lon)),
  }));
  const districtOf = (x, z) => districts.find((d) => d.polygon.length > 2 && pointInPolygon(x, z, d.polygon))?.id;
  return {
    places: PLACES.map((p) => {
      const r = at(p);
      if (p.dock) r.dock = { ...geo.toWorld(p.dock.lat, p.dock.lon), heading: p.dock.heading ?? 0 };
      if (p.landing) r.landing = geo.toWorld(p.landing.lat, p.landing.lon);
      r.district = p.district ?? districtOf(r.x, r.z) ?? 'northeast';
      return r;
    }),
    streams: STREAMS.map(at),
    districts,
    footprints: FOOTPRINTS.map(at),
    closedAreas: CLOSED_AREAS.map(at),
  };
}

let footprintCache = null;
let footprintGeo = null;
const FP_CELL = 200;
const fpKey = (i, j) => (i + 512) * 1024 + (j + 512);

// True when (x, z) lies inside a developed footprint. Terrain calls this per sample, so circles are bucketed into a
// 200 m hash grid (each circle is listed in every cell its bounding box touches).
export function isDeveloped(x, z, geo) {
  if (!footprintCache || footprintGeo !== geo) {
    footprintCache = new Map();
    for (const f of FOOTPRINTS) {
      const c = { ...geo.toWorld(f.lat, f.lon), r2: f.radius * f.radius };
      for (let i = Math.floor((c.x - f.radius) / FP_CELL); i <= Math.floor((c.x + f.radius) / FP_CELL); i++) {
        for (let j = Math.floor((c.z - f.radius) / FP_CELL); j <= Math.floor((c.z + f.radius) / FP_CELL); j++) {
          const k = fpKey(i, j);
          if (!footprintCache.has(k)) footprintCache.set(k, []);
          footprintCache.get(k).push(c);
        }
      }
    }
    footprintGeo = geo;
  }
  const list = footprintCache.get(fpKey(Math.floor(x / FP_CELL), Math.floor(z / FP_CELL)));
  if (!list) return false;
  for (const f of list) {
    const dx = x - f.x;
    const dz = z - f.z;
    if (dx * dx + dz * dz < f.r2) return true;
  }
  return false;
}

// Point-in-polygon for district lookup; polygon = [{ x, z }].
export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
