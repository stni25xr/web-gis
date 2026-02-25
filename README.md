# Web GIS Demo

## Bus 15 (Live/Simulated)

This project includes a demo Bus 15 stream for JLT (Öxnehaga ⇄ Huskvarna Esplanaden).

### Realtime
- If you have Trafiklab GTFS‑RT access for JLT, set `TRAFIKLAB_API_KEY` in `config.local.js`.
- If realtime is unavailable or blocked, the app falls back to a timetable‑based simulation.

### Simulation
- Headway: 60 minutes (hourly pattern)
- One‑way travel: ~23 minutes
- Buses loop outbound + inbound
- Positions are interpolated along GTFS shapes for a smooth loop

### Config
`config.local.js` should include:

```
window.TRAFIKLAB_API_KEY = "...";
window.GTFS_STATIC_KEY = "...";
window.GTFS_RT_KEY = "...";
```

Only the static key is required for the route shape; realtime is optional.
