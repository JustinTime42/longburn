import math
AU=1.495978707e11; GM=1.32712440018e20; g0=9.80665
def solve_rv(a,T,dr,v0,vB,iters=600):
    dv=[vB[i]-v0[i] for i in range(3)]; R=[dr[i]-v0[i]*T for i in range(3)]
    A1=[R[i]/T for i in range(3)]
    for k in range(iters):
        t1=math.sqrt(sum(c*c for c in A1))/a
        A2=[dv[i]-A1[i] for i in range(3)]; t2=math.sqrt(sum(c*c for c in A2))/a
        den=T-(t1+t2)/2
        if den<=0: return None
        A1=[0.5*A1[i]+0.5*((R[i]-dv[i]*t2/2)/den) for i in range(3)]
    t1=math.sqrt(sum(c*c for c in A1))/a
    A2=[dv[i]-A1[i] for i in range(3)]; t2=math.sqrt(sum(c*c for c in A2))/a
    return t1,t2,T-t1-t2,a*(t1+t2)
def state(r,th):
    v=math.sqrt(GM/r); return [r*math.cos(th),r*math.sin(th),0.0],[-v*math.sin(th),v*math.cos(th),0.0]
rE=AU; rM=1.524*AU; wM=math.sqrt(GM/rM**3)
rA,vA=state(rE,0.0)
print("=== finite-burn loss factor kappa = dvF(a)/dvF(a=inf), and burn duty cycle ===")
print(" T(d) |   a=1g          |   a=0.1g        |   a=0.01g")
for Td in [20,30,45,60,90,120,200]:
    T=Td*86400; rB,vB=state(rM,0.9+wM*T); dr=[rB[i]-rA[i] for i in range(3)]
    inf=solve_rv(1e9,T,dr,vA,vB)
    out=f" {Td:5d} |"
    for a in [1*g0,0.1*g0,0.01*g0]:
        s=solve_rv(a,T,dr,vA,vB)
        if s is None or s[2]<0: out+="  INFEASIBLE   |"
        else: out+=f" k={s[3]/inf[3]:5.3f} duty={(s[0]+s[1])/T*100:5.1f}% |"
    print(out)
print(f"   (impulsive flat-space dvF(inf) at T=45d: {solve_rv(1e9,45*86400,[state(rM,0.9+wM*45*86400)[0][i]-rA[i] for i in range(3)],vA,state(rM,0.9+wM*45*86400)[1])[3]/1000:.2f} km/s)")

print()
print("=== Edelbaum sanity: LEO -> GEO, plane change ===")
mu_E=3.986004418e14
def edelbaum(r0,rf,di_deg):
    v0=math.sqrt(mu_E/r0); vf=math.sqrt(mu_E/rf); di=math.radians(di_deg)
    return math.sqrt(v0*v0+vf*vf-2*v0*vf*math.cos(math.pi/2*di))
r0=6378e3+400e3; rf=42164e3
for di in [0,28.5,90]:
    dv=edelbaum(r0,rf,di)
    print(f"  LEO(400km)->GEO, di={di:5.1f} deg : Edelbaum dv={dv/1000:6.3f} km/s")
    for a_mms2 in [0.1,0.5,1.0]:
        a=a_mms2/1000
        print(f"     at a={a_mms2} mm/s^2 : spiral time = {dv/a/86400:8.1f} d")
# Hohmann comparison
v0=math.sqrt(mu_E/r0); vf=math.sqrt(mu_E/rf)
h1=v0*(math.sqrt(2*rf/(r0+rf))-1); h2=vf*(1-math.sqrt(2*r0/(r0+rf)))
print(f"  (impulsive Hohmann LEO->GEO coplanar: {(h1+h2)/1000:.3f} km/s vs Edelbaum {edelbaum(r0,rf,0)/1000:.3f} km/s -> low-thrust penalty {edelbaum(r0,rf,0)/(h1+h2):.2f}x)")

print()
print("=== const THRUST vs const ACCEL (field-free rocket) ===")
ve=100e3; m0=1e6; F=1e6; mdot=F/ve
print(f" ve={ve/1e3:.0f} km/s, m0={m0/1e3:.0f} t, F={F/1e6:.1f} MN, a0={F/m0:.3f} m/s^2, mdot={mdot:.2f} kg/s, burnout at t={m0/mdot/86400:.2f} d (full tank)")
for td in [0.5,1,2,4,8]:
    t=td*86400; m=m0-mdot*t
    if m<=0: continue
    v=ve*math.log(m0/m); x=ve*t+ve*(m/mdot)*math.log(m/m0)
    vc=(F/m0)*t; xc=0.5*(F/m0)*t*t
    print(f"  t={td:4.1f} d m={m/1e3:7.1f}t a(t)={F/m:6.3f} | const-F: v={v/1e3:7.2f} km/s x={x/1e9:7.3f} Gm | const-a(a0): v={vc/1e3:7.2f} x={xc/1e9:7.3f} | dv ratio {v/vc:5.3f} x ratio {x/xc:5.3f}")

print()
print("=== Tsiolkovsky mass ratio / payload fraction ===")
for ve_kms in [9,30,100,300,1000,3000,10000]:
    row=f" ve={ve_kms:6.0f} km/s (Isp={ve_kms*1000/g0:9.0f} s): "
    for dv in [5,50,200,600,1750]:
        r=math.exp(dv*1000/(ve_kms*1000))
        row+=f" dv{dv}:MR={r:9.3g}"
    print(row)
print()
print(" payload fraction f_pay = 1/MR - f_struct ; with f_struct (dry structure/tankage frac of wet mass)")
for ve_kms,dv in [(100,200),(100,600),(300,600),(300,1750),(1000,1750),(1000,600)]:
    MR=math.exp(dv*1000/(ve_kms*1000)); dry=1/MR
    for fs in [0.05,0.15]:
        print(f"  ve={ve_kms:5.0f} dv={dv:5.0f} MR={MR:8.3f} dry_frac={dry*100:6.2f}% struct={fs*100:.0f}% -> payload={max(0,(dry-fs))*100:6.2f}% of wet mass")
