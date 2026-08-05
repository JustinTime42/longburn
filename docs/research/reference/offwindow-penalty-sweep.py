import math
SRC = "/tmp/claude-1000/-home-justin-dev-longburn/4c76812e-81af-43d4-803e-a85e341f7a72/scratchpad/lam.py"
exec(open(SRC).read().split("# sanity:")[0])

nE_dpd = math.degrees(nE) * 86400
nM_dpd = math.degrees(nM) * 86400
rel = nE_dpd - nM_dpd
print(f"n_Earth={nE_dpd:.5f} deg/d  n_Mars={nM_dpd:.5f} deg/d  relative drift={rel:.5f} deg/d")
print(f"synodic = 360/{rel:.5f} = {360/rel:.2f} days")
print(f"sanity Hohmann@44.34deg/258.87d: {[round(x,4) for x in evaluate(44.34, 258.87)]}\n")


def scan(phase, lo=100, hi=650, step=3):
    bc = None
    bt = None
    for tof in range(lo, hi, step):
        r = evaluate(phase, tof)
        if r is None:
            continue
        c3, va, tot = r
        if bc is None or c3 < bc[0]:
            bc = (c3, va)
            bt = tof
    return bc, bt


best = None
p = 34.0
while p <= 56.0:
    bc, bt = scan(p, 150, 400, 2)
    if bc and (best is None or bc[0] < best[0]):
        best = (bc[0], p, bt, bc[1])
    p += 0.5

print(f"TOY OPTIMUM: min C3={best[0]:.3f} km2/s2 @ phase={best[1]:.1f} deg, "
      f"TOF={best[2]} d, vinf_arr={best[3]:.3f} km/s")
opt_phase, optC3 = best[1], best[0]

muE = 398600.4418
rLEO = 6378.137 + 200
vc = math.sqrt(muE / rLEO)


def tmi(c3):
    return math.sqrt(c3 + 2 * muE / rLEO) - vc


tmi_opt = tmi(optC3)
print(f"  -> TMI dV from 200 km LEO at optimum = {tmi_opt:.4f} km/s\n")

print("=== DEPARTING N DAYS OFF THE OPTIMAL DATE (circular-coplanar toy model) ===")
print(f"{'days off':>9} {'phase':>8} {'min C3':>9} {'TOF':>6} {'vinf_arr':>9} {'dV_TMI':>8} {'TMI penalty':>12}")
for d in [0, 10, 20, 30, 45, 60, 90, 120, 180, 260, 390, 520, 650, 720, 780]:
    ph = (opt_phase - d * rel) % 360
    bc, bt = scan(ph, 100, 650, 3)
    if bc:
        print(f"{d:9d} {ph:8.1f} {bc[0]:9.2f} {bt:6d} {bc[1]:9.3f} "
              f"{tmi(bc[0]):8.3f} {tmi(bc[0]) - tmi_opt:+11.3f}")
