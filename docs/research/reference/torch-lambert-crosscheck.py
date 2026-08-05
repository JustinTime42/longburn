import math
AU=1.495978707e11; GM=1.32712440018e20; g0=9.80665
def stumpC(z):
    if z>1e-8: return (1-math.cos(math.sqrt(z)))/z
    if z<-1e-8:
        s=math.sqrt(-z); return (math.cosh(s)-1)/(-z)
    return 0.5 - z/24 + z*z/720
def stumpS(z):
    if z>1e-8:
        s=math.sqrt(z); return (s-math.sin(s))/(s**3)
    if z<-1e-8:
        s=math.sqrt(-z); return (math.sinh(s)-s)/(s**3)
    return 1/6 - z/120 + z*z/5040
def lambert(r1,r2,dt,mu=GM,prograde=True):
    n1=math.sqrt(sum(c*c for c in r1)); n2=math.sqrt(sum(c*c for c in r2))
    cx=[r1[1]*r2[2]-r1[2]*r2[1], r1[2]*r2[0]-r1[0]*r2[2], r1[0]*r2[1]-r1[1]*r2[0]]
    dot=sum(r1[i]*r2[i] for i in range(3))
    c=max(-1,min(1,dot/(n1*n2))); dth=math.acos(c)
    if prograde:
        if cx[2]<=0: dth=2*math.pi-dth
    else:
        if cx[2]>=0: dth=2*math.pi-dth
    A=math.sin(dth)*math.sqrt(n1*n2/(1-math.cos(dth)))
    if abs(A)<1e-12: return None
    def yz(z):
        C=stumpC(z); S=stumpS(z)
        return n1+n2+A*(z*S-1)/math.sqrt(C)
    def F(z):
        C=stumpC(z); S=stumpS(z); y=yz(z)
        if y<0: return None
        return (y/C)**1.5*S + A*math.sqrt(y) - math.sqrt(mu)*dt
    # bracket
    z=-100.0
    while True:
        v=F(z)
        if v is not None and v<0: break
        z+=0.1
        if z>1e4: return None
    lo=z; hi=z
    while True:
        hi+=0.1
        v=F(hi)
        if v is not None and v>0: break
        if hi>4*math.pi**2*10: return None
    for _ in range(200):
        mid=(lo+hi)/2; v=F(mid)
        if v is None: lo=mid; continue
        if v<0: lo=mid
        else: hi=mid
    z=(lo+hi)/2; y=yz(z); C=stumpC(z)
    f=1-y/n1; gg=A*math.sqrt(y/mu); gdot=1-y/n2
    v1=[(r2[i]-f*r1[i])/gg for i in range(3)]
    v2=[(gdot*r2[i]-r1[i])/gg for i in range(3)]
    return v1,v2

def state(r,th):
    v=math.sqrt(GM/r)
    return [r*math.cos(th),r*math.sin(th),0.0],[-v*math.sin(th),v*math.cos(th),0.0]
rE=AU; rM=1.524*AU; wM=math.sqrt(GM/rM**3)
th0E=0.0; th0M=0.9
rA,vA=state(rE,th0E)
# sanity: Hohmann dv
at=(rE+rM)/2
dv1=math.sqrt(GM/rE)*(math.sqrt(2*rM/(rE+rM))-1)
dv2=math.sqrt(GM/rM)*(1-math.sqrt(2*rE/(rE+rM)))
Th=math.pi*math.sqrt(at**3/GM)
print(f"Hohmann Earth->Mars: dv1={dv1/1000:.3f} dv2={dv2/1000:.3f} total={(dv1+dv2)/1000:.3f} km/s, T={Th/86400:.1f} d")
print()
print(" T(d) | Lambert dv (km/s) | flat-space torch dv @0.1g (km/s)")
def solve_rv(a,T,dr,v0,vB,iters=500):
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
for Td in [20,30,45,60,90,120,150,200,250,259,300,350]:
    T=Td*86400
    rB,vB=state(rM,th0M+wM*T)
    L=lambert(rA,rB,T)
    if L:
        v1,v2=L
        d1=math.sqrt(sum((v1[i]-vA[i])**2 for i in range(3)))
        d2=math.sqrt(sum((vB[i]-v2[i])**2 for i in range(3)))
        lam=(d1+d2)/1000
    else: lam=float('nan')
    dr=[rB[i]-rA[i] for i in range(3)]
    s=solve_rv(0.1*g0,T,dr,vA,vB)
    fs=s[3]/1000 if (s and s[2]>=0) else float('nan')
    print(f" {Td:5d} | {lam:12.2f}      | {fs:12.2f}   ratio={fs/lam if lam==lam else 0:6.1f}x")
