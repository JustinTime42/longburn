import math

MU = 1.32712440018e11  # km^3/s^2 Sun

def lambert_izzo_simple(r1v, r2v, tof, mu=MU, prograde=True):
    """Universal-variable / Battin-free Lambert via bisection on the 'z' (Bate-Mueller-White)."""
    r1 = math.dist((0,0,0), r1v); r2 = math.dist((0,0,0), r2v)
    cross_z = r1v[0]*r2v[1] - r1v[1]*r2v[0]
    dot = sum(a*b for a,b in zip(r1v, r2v))
    dnu = math.acos(max(-1,min(1,dot/(r1*r2))))
    if prograde:
        if cross_z <= 0: dnu = 2*math.pi - dnu
    else:
        if cross_z >= 0: dnu = 2*math.pi - dnu
    A = math.sin(dnu)*math.sqrt(r1*r2/(1-math.cos(dnu)))
    if A == 0: return None

    def C(z):
        if z > 1e-6:  return (1-math.cos(math.sqrt(z)))/z
        if z < -1e-6:
            s=math.sqrt(-z); return (math.cosh(s)-1)/(-z)
        return 0.5 - z/24 + z*z/720
    def S(z):
        if z > 1e-6:
            s=math.sqrt(z); return (s-math.sin(s))/(s**3)
        if z < -1e-6:
            s=math.sqrt(-z); return (math.sinh(s)-s)/(s**3)
        return 1/6 - z/120 + z*z/5040
    def y(z):
        c=C(z)
        return r1 + r2 + A*(z*S(z)-1)/math.sqrt(c)
    def F(z):
        yy = y(z)
        if yy < 0: return None
        c=C(z)
        x = math.sqrt(yy/c)
        return (x**3)*S(z) + A*math.sqrt(yy) - math.sqrt(mu)*tof

    lo, hi = -4*math.pi**2 + 1e-6, 4*math.pi**2 - 1e-6
    flo = F(lo)
    while flo is None and lo < 0:
        lo += 0.5; flo = F(lo)
    fhi = F(hi)
    if flo is None or fhi is None or flo*fhi > 0: return None
    for _ in range(300):
        mid=(lo+hi)/2; fm=F(mid)
        if fm is None: hi=mid; continue
        if flo*fm <= 0: hi, fhi = mid, fm
        else: lo, flo = mid, fm
    z=(lo+hi)/2
    yy=y(z)
    f = 1 - yy/r1
    g = A*math.sqrt(yy/mu)
    gdot = 1 - yy/r2
    v1 = tuple((r2v[i]-f*r1v[i])/g for i in range(3))
    v2 = tuple((gdot*r2v[i]-r1v[i])/g for i in range(3))
    return v1, v2

# Circular coplanar toy model
AU=1.495978707e8
rE=1.0*AU; rM=1.523679*AU
vE=math.sqrt(MU/rE); vM=math.sqrt(MU/rM)
TE=math.tau*math.sqrt(rE**3/MU); TM=math.tau*math.sqrt(rM**3/MU)
nE=math.tau/TE; nM=math.tau/TM

def evaluate(phase_deg, tof_days):
    """phase = Mars angular lead over Earth at departure (deg)."""
    tof = tof_days*86400
    thE=0.0; thM=math.radians(phase_deg)
    r1v=(rE*math.cos(thE), rE*math.sin(thE), 0.0)
    thM2 = thM + nM*tof
    r2v=(rM*math.cos(thM2), rM*math.sin(thM2), 0.0)
    res = lambert_izzo_simple(r1v, r2v, tof)
    if res is None: return None
    v1,v2 = res
    vEv=(-vE*math.sin(thE), vE*math.cos(thE), 0.0)
    vMv=(-vM*math.sin(thM2), vM*math.cos(thM2), 0.0)
    vinf_d = math.dist(v1, vEv)
    vinf_a = math.dist(v2, vMv)
    return vinf_d**2, vinf_a, vinf_d+vinf_a

# sanity: Hohmann phase 44.34 deg, tof 258.87 d
print("SANITY (should reproduce Hohmann: C3~8.67, vinf_arr~2.65, total~5.59):")
print(" ", [round(x,4) for x in evaluate(44.34, 258.87)])
print()
print("=== Best (min C3) over TOF for each departure phase angle, circular-coplanar toy model ===")
print(f"{'phase(deg)':>10} {'bestC3':>9} {'TOF@bestC3':>11} {'vinf_arr':>9} | {'min totalVinf':>13} {'TOF':>6}")
for phase in range(0,360,10):
    best=None; bestT=None
    for tof in range(80, 600, 2):
        r=evaluate(phase, tof)
        if r is None: continue
        c3,va,tot = r
        if best is None or c3<best[0]: best=(c3,va); bestT=tof
    bestv=None; bestvT=None
    for tof in range(80,600,2):
        r=evaluate(phase,tof)
        if r is None: continue
        c3,va,tot=r
        if bestv is None or tot<bestv: bestv=tot; bestvT=tof
    if best:
        print(f"{phase:10d} {best[0]:9.2f} {bestT:11d} {best[1]:9.3f} | {bestv:13.3f} {bestvT:6d}")
