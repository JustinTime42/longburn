import math
g0=9.80665; AU=1.495978707e11; GM=1.32712440018e20
def solve_rv(a,T,dr,v0,vB,iters=500):
    dv=[vB[i]-v0[i] for i in range(3)]; R=[dr[i]-v0[i]*T for i in range(3)]
    A1=[R[i]/T for i in range(3)]
    for k in range(iters):
        t1=math.sqrt(sum(c*c for c in A1))/a
        A2=[dv[i]-A1[i] for i in range(3)]; t2=math.sqrt(sum(c*c for c in A2))/a
        den=T-(t1+t2)/2
        if den<=0: return None
        new=[(R[i]-dv[i]*t2/2)/den for i in range(3)]
        A1=[0.5*A1[i]+0.5*new[i] for i in range(3)]
    t1=math.sqrt(sum(c*c for c in A1))/a
    A2=[dv[i]-A1[i] for i in range(3)]; t2=math.sqrt(sum(c*c for c in A2))/a
    return t1,t2,T-t1-t2,a*(t1+t2)

# circular coplanar Earth (1 AU) and Mars (1.524 AU), target propagated to t0+T
def state(r,th):
    v=math.sqrt(GM/r)
    return [r*math.cos(th),r*math.sin(th),0.0],[-v*math.sin(th),v*math.cos(th),0.0]
rE=AU; rM=1.524*AU
wE=math.sqrt(GM/rE**3); wM=math.sqrt(GM/rM**3)
syn=2*math.pi/abs(wE-wM)
print(f"synodic period = {syn/86400:.1f} d ; Earth v={math.sqrt(GM/rE)/1000:.2f} Mars v={math.sqrt(GM/rM)/1000:.2f} km/s")
th0E=0.0; th0M=0.9   # Mars leads by 0.9 rad at departure
rA,v0=state(rE,th0E)
print()
for a,label in [(1.0*g0,"1 g"),(0.1*g0,"0.1 g"),(0.01*g0,"0.01 g")]:
    print(f"--- a = {label} ({a:.4f} m/s^2), PROPAGATED target (dr,vB = f(T)) ---")
    best=(1e18,None)
    rows=[]
    for Td in [2,3,4,5,7,10,15,20,30,45,60,90,120,150,200,250,300]:
        T=Td*86400
        rB,vB=state(rM,th0M+wM*T)
        dr=[rB[i]-rA[i] for i in range(3)]
        s=solve_rv(a,T,dr,v0,vB)
        if s is None or s[2]<0: rows.append((Td,None,None,math.sqrt(sum(c*c for c in dr))/AU)); continue
        rows.append((Td,s[3],s[2],math.sqrt(sum(c*c for c in dr))/AU))
        if s[3]<best[0]: best=(s[3],Td)
    for Td,dv,co,ch in rows:
        if dv is None: print(f"   T={Td:5d} d  chord={ch:5.3f} AU  INFEASIBLE (burn time > T)")
        else: print(f"   T={Td:5d} d  chord={ch:5.3f} AU  dv={dv/1000:9.2f} km/s  coast={co/86400:8.2f} d")
    print(f"   -> min dv {best[0]/1000:.2f} km/s at T={best[1]} d")
    print()
