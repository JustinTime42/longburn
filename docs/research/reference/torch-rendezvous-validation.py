import math
g0=9.80665; AU=1.495978707e11
# exact piecewise propagation (analytic, no numerical integration)
def propagate(a,t1,tc,t2):
    x=0.5*a*t1*t1; v=a*t1
    x+=v*tc
    x+=v*t2-0.5*a*t2*t2; v-=a*t2
    return x,v
D=0.75*AU; a=0.1*g0
Tb=2*math.sqrt(D/a)
print(f"=== Closed form check: D={D/AU} AU, a={a:.4f} m/s^2, T_brach={Tb/86400:.4f} d, dv_brach={2*math.sqrt(D*a)/1000:.2f} km/s")
for mult in [1.0,1.2,1.5,2.0,3.0,10.0,100.0]:
    T=Tb*mult; disc=T*T-4*D/a; tb=(T-math.sqrt(disc))/2; tc=T-2*tb
    dv=a*(T-math.sqrt(disc))
    x,v=propagate(a,tb,tc,tb)
    print(f" T={mult:6.1f}xTb | tb={tb/86400:9.4f}d tc={tc/86400:10.4f}d | dv={dv/1000:9.3f} km/s | check dv=2a*tb={2*a*tb/1000:9.3f} | x_err={(x-D)/D:+.2e} v_end={v:+.3e} | 2D/T floor={2*D/T/1000:8.3f}")

print()
print("=== Cross-check vs Spaceship Handbook (Jon C. Rogers) round-trip Terra<->Mars ===")
for label,acc,rt_dv,rt_t in [("1.00g",1.0*g0,3_508_000,4),("0.10g",0.1*g0,1_115_000,12),("0.01g",0.01*g0,370_000,30)]:
    Dfit=(rt_dv/2/2)**2/acc   # one-way dv = rt/2 ; D = (dv/2)^2/a
    ow_dv=2*math.sqrt(0.52*AU*acc); ow_T=2*math.sqrt(0.52*AU/acc)
    print(f" {label}: handbook RT dv={rt_dv/1000:8.1f} km/s ({rt_t}d) | my 0.52AU one-way dv={ow_dv/1000:8.1f} -> RT {2*ow_dv/1000:8.1f} km/s, RT time {2*ow_T/86400:6.2f} d | implied D={Dfit/AU:.3f} AU")

print()
print("=== Moving-target 3D rendezvous solver (flat space, piecewise-const thrust) ===")
def solve_rendezvous(a,T,dr,v0,vB,iters=200,tol=1e-10):
    # unknowns A1 (vector). t1=|A1|/a, t2=|dv-A1|/a
    dv=[vB[i]-v0[i] for i in range(3)]
    R=[dr[i]-v0[i]*T for i in range(3)]
    A1=[R[i]/T for i in range(3)]   # impulsive seed
    for k in range(iters):
        t1=math.sqrt(sum(c*c for c in A1))/a
        A2=[dv[i]-A1[i] for i in range(3)]
        t2=math.sqrt(sum(c*c for c in A2))/a
        den=T-(t1+t2)/2
        if den<=0: return None
        new=[(R[i]-dv[i]*t2/2)/den for i in range(3)]
        err=max(abs(new[i]-A1[i]) for i in range(3))
        A1=[0.5*A1[i]+0.5*new[i] for i in range(3)]  # damped
        if err<tol: break
    t1=math.sqrt(sum(c*c for c in A1))/a
    A2=[dv[i]-A1[i] for i in range(3)]
    t2=math.sqrt(sum(c*c for c in A2))/a
    return A1,A2,t1,t2,T-t1-t2

def check(a,T,dr,v0,vB,sol):
    A1,A2,t1,t2,tc=sol
    u1=[c/(a*t1) for c in A1]; u2=[c/(a*t2) for c in A2]
    # propagate
    x=[0,0,0]; v=list(v0)
    for i in range(3): x[i]+=v[i]*t1+0.5*a*u1[i]*t1*t1; 
    for i in range(3): v[i]+=a*u1[i]*t1
    for i in range(3): x[i]+=v[i]*tc
    for i in range(3): x[i]+=v[i]*t2+0.5*a*u2[i]*t2*t2
    for i in range(3): v[i]+=a*u2[i]*t2
    perr=max(abs(x[i]-dr[i]) for i in range(3))
    verr=max(abs(v[i]-vB[i]) for i in range(3))
    return perr,verr

# Earth -> Mars-ish: heliocentric, Earth at 1AU moving 29.78 km/s +y, Mars target 1.524AU
a=0.1*g0
rA=[AU,0,0]; v0=[0,29780.0,0]
th=0.9
rB=[1.524*AU*math.cos(th),1.524*AU*math.sin(th),0.02*AU]
vMars=24070.0
vB=[-vMars*math.sin(th),vMars*math.cos(th),0.0]
dr=[rB[i]-rA[i] for i in range(3)]
Dchord=math.sqrt(sum(c*c for c in dr))
print(f" chord |dr| = {Dchord/AU:.4f} AU ; a={a:.4f} m/s^2")
for mult in [1.0,1.3,2.0,4.0,10.0]:
    T=mult*2*math.sqrt(Dchord/a)
    sol=solve_rendezvous(a,T,dr,v0,vB)
    if sol is None: print(f"  T={T/86400:8.3f} d : infeasible"); continue
    A1,A2,t1,t2,tc=sol
    dv=a*(t1+t2)
    perr,verr=check(a,T,dr,v0,vB,sol)
    fs="OK " if tc>=0 else "NO-COAST(infeasible)"
    print(f"  T={T/86400:8.3f} d | t1={t1/86400:7.3f} t2={t2/86400:7.3f} coast={tc/86400:9.3f} d | dv={dv/1000:8.2f} km/s | {fs} | pos_err={perr:.3e} m vel_err={verr:.3e} m/s")
