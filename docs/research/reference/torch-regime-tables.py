import math
g0=9.80665; AU=1.495978707e11
GMsun=1.32712440018e20
def T_brach(D,a): return 2*math.sqrt(D/a)
def dv_brach(D,a): return 2*math.sqrt(D*a)
def dv_coast(D,a,T):
    disc=T*T-4*D/a
    if disc<0: return None
    tb=(T-math.sqrt(disc))/2
    return a*(T-math.sqrt(disc)), tb, T-2*tb
print("solar g at r (m/s^2, and in milligee):")
for r in [0.39,0.72,1.0,1.524,2.7,5.2,9.5,30.1]:
    gs=GMsun/(r*AU)**2
    print(f"  {r:5.2f} AU: {gs:.4e} m/s^2 = {gs/g0*1000:8.3f} mg")
print()
dists={"0.52 AU (Earth-Mars opposition)":0.52*AU,
       "0.75 AU (typical launch geometry)":0.75*AU,
       "1.00 AU":1.00*AU,
       "1.70 AU (near conjunction, long way)":1.70*AU,
       "4.20 AU (Earth-Jupiter opposition)":4.20*AU,
       "1.60 AU (Earth-Ceres opp)":1.60*AU}
accs={"1 g":g0,"0.3 g":0.3*g0,"0.1 g":0.1*g0,"0.03 g":0.03*g0,
      "0.01 g":0.01*g0,"3 mg":0.003*g0,"1 mg":0.001*g0}
for dn,D in dists.items():
    print(f"--- {dn}  (D={D/1e9:.1f} Gm) ---")
    for an,a in accs.items():
        T=T_brach(D,a); dv=dv_brach(D,a); vpk=dv/2
        err=2*(GMsun/AU**2)/a
        print(f"  {an:6s} a={a:8.4f} m/s2 | T={T/86400:9.3f} d ({T/3600:8.2f} h) | dv={dv/1000:9.1f} km/s | vpeak={vpk/1000:8.1f} km/s | flat-space err~{err*100:7.2f}%")
    print()
