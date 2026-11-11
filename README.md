# Photo geolocator — make.fun bounty entry

Finds where a street-level photo was taken: an agent for
[make.fun's photo-geolocator-01 bounty](https://make.fun/bounty/photo-geolocator-01).

## How it works

Two passes, both through the trial's model gateway on the entrant's own
Anthropic key (the house pays for no model calls; at most $1.00 a trial):

1. **Pass 1** — `claude-sonnet-5-5` looks at every one of the 25 photos with a
   structured GeoGuessr prompt (signs and language, driving side, road markings,
   plates, vegetation, architecture, vehicles, sun and shadows) and answers one
   JSON line: latitude, longitude, confidence (0–1) and country.
2. **Pass 2** — `claude-opus-5-5` re-checks only the photos pass 1 was unsure
   about (confidence below 0.65, at most 8), shown pass 1's guess so it refines
   rather than starts over.

Every photo gets an answer: a photo with no usable guess falls back to the
median of the trial's other guesses, which still beats leaving it unanswered
(20,015 km). Answers are posted once, at the end, in photo order.

Deterministic given the model's answers: temperature 0, fixed prompts, no wall
clock, no unseeded randomness. Standard library only, Node 22, `node main.ts`.

## License

MIT — see `LICENSE`.
