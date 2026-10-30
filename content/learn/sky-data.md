---
title: Sky data
order: 2
---

# Sky data

Sky data is organised in **groups**. Each group holds **objects**, and each object has **fields**. A piece follows the groups it names; Sphärenmusik delivers changes in those groups only.

## Kinds of data
Sky data changes in four ways. Each suits a different part of a piece.

| Kind | How it changes | Examples | Use it for |
|---|---|---|---|
| VLFO (very-low-frequency oscillator) | Repeats smoothly, once per orbit | A satellite's latitude, its position around the orbit, whether it is in sunlight | Slow sweeps, panning, cycles that last an orbit ([Effects and modulation](effects-and-modulation#orbits-as-very-slow-lfos)) |
| Step function | Holds a value, then jumps to another at the next update | Orbital elements, asteroid distances, launch times | Pitches, chords, choosing which objects sound |
| Random walk | Wanders continuously without repeating | Solar wind speed, the magnetic field, Kp | Filters, effect depths, anything that should drift |
| Trigger | Happens at one moment | A Scout candidate appearing, a launch lifting off, an object entering or leaving a group | Single notes and visual flashes ([Sound](sound#triggers)) |

## Groups
| Group | Objects | Changes |
|---|---|---|
| `celestrak.stations` | Space stations, including the ISS | Every 2 hours |
| `celestrak.gps-ops` | Operational GPS satellites (about 30) | Every 2 hours |
| `celestrak.visual` | The brightest satellites (about 150) | Every 2 hours |
| `celestrak.cosmos-2251-debris` | Debris fragments from the 2009 Cosmos 2251 collision (several hundred) | Every 2 hours |
| `swpc.kp` | One object: planetary geomagnetic activity | Every minute |
| `swpc.wind` | One object: solar wind measured upstream of Earth | Every minute |
| `swpc.mag` | One object: the interplanetary magnetic field | Every minute |
| `jpl.cad` | Asteroids and comets passing within 10 lunar distances in the next 60 days | Every 6 hours |
| `jpl.scout` | Newly observed objects that might be near-Earth asteroids | Every 15 minutes |
| `ll2.upcoming` | The next 10 rocket launches | Every 10 minutes |

Objects **enter** a group when they first appear, **update** when any field changes, and **exit** when they leave: a launch that has flown, a Scout candidate that is confirmed or dropped, an asteroid whose approach has passed.

## Fields
### Orbits (`celestrak.*`)
| Field | Meaning | Typical range |
|---|---|---|
| `name` | Object name, for example `ISS (ZARYA)` | |
| `noradId` | Catalog number | |
| `meanMotion` | Orbits per day | 1–16 |
| `inclination` | Tilt of the orbit to the equator, degrees | 0–180 |
| `raan` | Direction of the orbit's ascending node, degrees | 0–360 |
| `eccentricity` | 0 is circular; larger is more elongated | 0–0.1 for most |
| `argPericenter` | Direction of the lowest point, degrees | 0–360 |
| `meanAnomaly` | Position along the orbit at `epoch`, degrees | 0–360 |
| `bstar` | Drag term | near 0 |
| `epoch` | Time the elements describe | |

### Space weather (`swpc.*`)
Read space weather with `sky.swpc(path)`.

| Path | Meaning | Typical range |
|---|---|---|
| `kp.kp` | Kp index of geomagnetic activity; 5 and above is a storm | 0–9 |
| `kp.kpEstimated` | Estimated Kp for the current minute | 0–9 |
| `wind.speed` | Solar wind speed, km/s | 300–800 |
| `wind.density` | Proton density, per cm³ | 1–20 |
| `wind.temperature` | Proton temperature, K | 10,000–500,000 |
| `mag.bt` | Total field strength, nT | 1–20 |
| `mag.bz` | North–south field component, nT; negative (southward) values drive aurora | −20–20 |

### Close approaches (`jpl.cad`)
| Field | Meaning | Typical range |
|---|---|---|
| `des` | Designation, for example `2026 TX` | |
| `closeApproach` | Date and time of closest approach | |
| `distLD` | Closest distance in lunar distances | 0–10 |
| `distAu` | Closest distance in astronomical units | 0–0.03 |
| `vRel` | Speed relative to Earth, km/s | 1–40 |
| `vInf` | Speed relative to a massless Earth, km/s | 1–40 |
| `h` | Absolute magnitude; smaller is larger | 15–32 |

### Scout candidates (`jpl.scout`)
| Field | Meaning | Typical range |
|---|---|---|
| `objectName` | Temporary designation | |
| `neoScore` | Likelihood of being a near-Earth object | 0–100 |
| `phaScore` | Likelihood of being potentially hazardous | 0–100 |
| `nObs` | Number of observations | 3–50 |
| `arc` | Observation span, days | 0–5 |
| `h` | Absolute magnitude | 15–32 |
| `vInf` | Speed, km/s | 1–40 |
| `rating` | Scout's rating string | |

### Launches (`ll2.upcoming`)
| Field | Meaning |
|---|---|
| `name` | Rocket and mission |
| `net` | Planned launch time |
| `status` | `Go`, `TBC`, `TBD`, `Hold`, `In Flight`, `Success`, `Failure` |
| `provider` | Launch provider |
| `padLat`, `padLon` | Launch pad position, degrees |

A field can be `null` when the source does not report it. Expressions pass `null` through, and a note whose pitch is `null` does not play.

## Browsing live values
The **Sky** panel in the editor's sidebar lists every group with its objects and current field values. Selecting a field inserts `field('<name>')` at the cursor.

## Which groups a piece follows
Sphärenmusik follows every group the script names, in any `sky.group(...)`, `sky.swpc(...)` or `layer.*(...)` call. The Projects list shows them per project. A piece that names no group receives no data.

## Choosing groups
- For change you can hear while you listen, use `swpc.*`: it changes every minute.
- For a stable structure, such as a chord or a field of points, use `celestrak.*`.
- For rare events, use `jpl.scout` entries and launch status changes.
- Large groups such as debris suit counts, averages and point clouds better than one voice per object; an instrument plays at most 16 voices.
