# Multimodal transit boundary

The application contains no static station-proximity or straight-line transit recommendation fallback. Transit is disabled by default and reports an explicit capability state.

The target architecture is an isolated OpenTripPlanner 2.9 service using official GTFS, OpenStreetMap street routing, and GTFS-Realtime. City infrastructure—not clients—must fetch and redistribute MTA data. The router adapter must provide separate drive, parking transfer, transit, transfer, and walk legs; scheduled versus realtime times; alerts; accessibility state; known fare components; feed timestamps; and return-to-car time.

Before any park-and-ride option is eligible, it must:

1. Receive a typed origin or explicitly authorized current location.
2. Generate several viable outbound and return corridors.
3. Use only validated curb or active licensed-facility anchors.
4. Validate the parked-car interval from initial parking through estimated return to the vehicle.
5. Reject any red, gray, stale, partial-coverage, or unsupported parking anchor.
6. Warn when realtime is more than one minute behind and never label stale data live.
7. For accessible trips, require a complete validated step-free path with no active outage; otherwise make no accessibility claim and link to official status.

OTP configuration, MTA credentials, licensed assets, production feeds, and branded symbols are intentionally absent from this repository until the responsible agencies supply and approve them.
