"""Reproducible Earth--Mars flat-space rendezvous fixture generator.

The target is advanced to its arrival epoch for every cell.  This is the
oracle used by the TypeScript tests; do not replace it with the older frozen-
angle demonstration in torch-rendezvous-validation.py.
"""

import math

AU = 149_597_870_700.0
G0 = 9.80665
EARTH_SPEED = 29_780.0
MARS_RADIUS = 1.524 * AU
MARS_SPEED = 24_070.0
DEPARTURE_ANGLE = 0.9


def solve(acceleration, duration):
    """Fixed-work §3.2 solve, returning coast seconds and delta-v m/s."""
    arrival_angle = DEPARTURE_ANGLE + MARS_SPEED / MARS_RADIUS * duration
    departure_position = (AU, 0.0, 0.0)
    arrival_position = (
        MARS_RADIUS * math.cos(arrival_angle),
        MARS_RADIUS * math.sin(arrival_angle),
        0.02 * AU,
    )
    departure_velocity = (0.0, EARTH_SPEED, 0.0)
    arrival_velocity = (
        -MARS_SPEED * math.sin(arrival_angle),
        MARS_SPEED * math.cos(arrival_angle),
        0.0,
    )
    delta_velocity = tuple(arrival_velocity[i] - departure_velocity[i] for i in range(3))
    displacement = tuple(arrival_position[i] - departure_position[i] - departure_velocity[i] * duration for i in range(3))
    first_impulse = [component / duration for component in displacement]
    for _ in range(200):
        first_duration = math.sqrt(sum(component * component for component in first_impulse)) / acceleration
        second_impulse = [delta_velocity[i] - first_impulse[i] for i in range(3)]
        second_duration = math.sqrt(sum(component * component for component in second_impulse)) / acceleration
        denominator = duration - (first_duration + second_duration) / 2
        if denominator == 0:
            continue
        next_impulse = [(displacement[i] - delta_velocity[i] * second_duration / 2) / denominator for i in range(3)]
        first_impulse = [(first_impulse[i] + next_impulse[i]) / 2 for i in range(3)]
    first_duration = math.sqrt(sum(component * component for component in first_impulse)) / acceleration
    second_impulse = [delta_velocity[i] - first_impulse[i] for i in range(3)]
    second_duration = math.sqrt(sum(component * component for component in second_impulse)) / acceleration
    return duration - first_duration - second_duration, acceleration * (first_duration + second_duration)


for days in (2, 4, 10, 20, 30, 60, 120):
    for gee in (1.0, 0.1, 0.01):
        coast, delta_v = solve(gee * G0, days * 86_400)
        value = "infeasible" if coast < 0 else f"{delta_v / 1000:.2f} km/s"
        print(f"{days:3d} d @ {gee:4.2f} g: {value} (coast {coast / 86_400:.3f} d)")
