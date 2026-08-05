"""Pure-python transcription of Izzo (2015) Lambert solver + universal-variable
Kepler propagator, used to verify test vectors. No numpy."""
import math

# ---------- tiny vec3 ----------
def sub(a, b): return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
def add(a, b): return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]
def scale(a, k): return [a[0]*k, a[1]*k, a[2]*k]
def dot(a, b): return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
def cross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def norm(a): return math.sqrt(dot(a, a))
def unit(a):
    n = norm(a)
    return [a[0]/n, a[1]/n, a[2]/n]

# ---------- Izzo ----------
def hyp2f1b(x):
    if x >= 1.0:
        return math.inf
    res = 1.0
    term = 1.0
    ii = 0
    while True:
        term = term * (3 + ii) * (1 + ii) / (5/2 + ii) * x / (ii + 1)
        res_old = res
        res += term
        if res_old == res:
            return res
        ii += 1

def _compute_y(x, ll):
    return math.sqrt(1 - ll**2 * (1 - x**2))

def _compute_psi(x, y, ll):
    if -1 <= x < 1:
        return math.acos(max(-1.0, min(1.0, x*y + ll*(1 - x**2))))
    elif x > 1:
        return math.asinh((y - x*ll) * math.sqrt(x**2 - 1))
    return 0.0

def _tof_equation_y(x, y, T0, ll, M):
    if M == 0 and math.sqrt(0.6) < x < math.sqrt(1.4):
        eta = y - ll*x
        S_1 = (1 - ll - x*eta) * 0.5
        Q = 4/3 * hyp2f1b(S_1)
        T_ = (eta**3 * Q + 4*ll*eta) * 0.5
    else:
        psi = _compute_psi(x, y, ll)
        T_ = ((psi + M*math.pi) / math.sqrt(abs(1 - x**2)) - x + ll*y) / (1 - x**2)
    return T_ - T0

def _tof_equation(x, T0, ll, M):
    return _tof_equation_y(x, _compute_y(x, ll), T0, ll, M)

def _tof_equation_p(x, y, T, ll):
    return (3*T*x - 2 + 2*ll**3*x/y) / (1 - x**2)

def _tof_equation_p2(x, y, T, dT, ll):
    return (3*T + 5*x*dT + 2*(1 - ll**2)*ll**3/y**3) / (1 - x**2)

def _tof_equation_p3(x, y, _, dT, ddT, ll):
    return (7*x*ddT + 8*dT - 6*(1 - ll**2)*ll**5*x/y**5) / (1 - x**2)

def _halley(p0, T0, ll, atol, rtol, maxiter):
    for _ in range(maxiter):
        y = _compute_y(p0, ll)
        fder = _tof_equation_p(p0, y, T0, ll)
        fder2 = _tof_equation_p2(p0, y, T0, fder, ll)
        if fder2 == 0:
            raise RuntimeError("Derivative was zero")
        fder3 = _tof_equation_p3(p0, y, T0, fder, fder2, ll)
        p = p0 - 2*fder*fder2 / (2*fder2**2 - fder*fder3)
        if abs(p - p0) < rtol*abs(p0) + atol:
            return p
        p0 = p
    raise RuntimeError("Halley failed to converge")

def _compute_T_min(ll, M, maxiter, atol, rtol):
    if ll == 1:
        x_T_min = 0.0
        T_min = _tof_equation(x_T_min, 0.0, ll, M)
    else:
        if M == 0:
            x_T_min = math.inf
            T_min = 0.0
        else:
            x_i = 0.1
            T_i = _tof_equation(x_i, 0.0, ll, M)
            x_T_min = _halley(x_i, T_i, ll, atol, rtol, maxiter)
            T_min = _tof_equation(x_T_min, 0.0, ll, M)
    return x_T_min, T_min

def _initial_guess(T, ll, M, is_low_path):
    if M == 0:
        T_0 = math.acos(ll) + ll*math.sqrt(1 - ll**2)
        T_1 = 2*(1 - ll**3)/3
        if T >= T_0:
            return (T_0/T)**(2/3) - 1
        elif T < T_1:
            return 5/2 * T_1/T * (T_1 - T)/(1 - ll**5) + 1
        else:
            return math.exp(math.log(2) * math.log(T/T_0) / math.log(T_1/T_0)) - 1
    else:
        x_0l = (((M*math.pi + math.pi)/(8*T))**(2/3) - 1) / (((M*math.pi + math.pi)/(8*T))**(2/3) + 1)
        x_0r = (((8*T)/(M*math.pi))**(2/3) - 1) / (((8*T)/(M*math.pi))**(2/3) + 1)
        return max(x_0l, x_0r) if is_low_path else min(x_0l, x_0r)

def _householder(p0, T0, ll, M, atol, rtol, maxiter):
    for it in range(1, maxiter + 1):
        y = _compute_y(p0, ll)
        fval = _tof_equation_y(p0, y, T0, ll, M)
        T = fval + T0
        fder = _tof_equation_p(p0, y, T, ll)
        fder2 = _tof_equation_p2(p0, y, T, fder, ll)
        fder3 = _tof_equation_p3(p0, y, T, fder, fder2, ll)
        p = p0 - fval*((fder**2 - fval*fder2/2) /
                       (fder*(fder**2 - fval*fder2) + fder3*fval**2/6))
        if abs(p - p0) < rtol*abs(p0) + atol:
            return p, it
        p0 = p
    raise RuntimeError("Householder failed to converge")

def _find_xy(ll, T, M, maxiter, atol, rtol, is_low_path):
    assert abs(ll) < 1
    M_max = math.floor(T/math.pi)
    T_00 = math.acos(ll) + ll*math.sqrt(1 - ll**2)
    if T < T_00 + M_max*math.pi and M_max > 0:
        _, T_min = _compute_T_min(ll, M_max, maxiter, atol, rtol)
        if T < T_min:
            M_max -= 1
    if M > M_max:
        raise ValueError("No feasible solution, try lower M! (M_max=%d)" % M_max)
    x_0 = _initial_guess(T, ll, M, is_low_path)
    x, it = _householder(x_0, T, ll, M, atol, rtol, maxiter)
    return x, _compute_y(x, ll), it, M_max

def izzo2015(mu, r1, r2, tof, M=0, is_prograde=True, is_low_path=True,
             maxiter=35, atol=1e-5, rtol=1e-7):
    c = sub(r2, r1)
    c_norm, r1_norm, r2_norm = norm(c), norm(r1), norm(r2)
    s = (r1_norm + r2_norm + c_norm) * 0.5
    i_r1, i_r2 = unit(r1), unit(r2)
    i_h = unit(cross(i_r1, i_r2))
    ll = math.sqrt(1 - min(1.0, c_norm/s))
    if i_h[2] < 0:
        ll = -ll
        i_t1, i_t2 = cross(i_r1, i_h), cross(i_r2, i_h)
    else:
        i_t1, i_t2 = cross(i_h, i_r1), cross(i_h, i_r2)
    if not is_prograde:
        ll, i_t1, i_t2 = -ll, scale(i_t1, -1), scale(i_t2, -1)
    T = math.sqrt(2*mu/s**3) * tof
    x, y, iters, M_max = _find_xy(ll, T, M, maxiter, atol, rtol, is_low_path)
    gamma = math.sqrt(mu*s/2)
    rho = (r1_norm - r2_norm)/c_norm
    sigma = math.sqrt(1 - rho**2)
    V_r1 = gamma*((ll*y - x) - rho*(ll*y + x))/r1_norm
    V_r2 = -gamma*((ll*y - x) + rho*(ll*y + x))/r2_norm
    V_t1 = gamma*sigma*(y + ll*x)/r1_norm
    V_t2 = gamma*sigma*(y + ll*x)/r2_norm
    v1 = add(scale(i_r1, V_r1), scale(i_t1, V_t1))
    v2 = add(scale(i_r2, V_r2), scale(i_t2, V_t2))
    return v1, v2, iters, M_max

# ---------- universal-variable Kepler propagator (Vallado alg 8) ----------
def stumpff_c2c3(psi):
    if psi > 1e-6:
        sp = math.sqrt(psi)
        c2 = (1 - math.cos(sp))/psi
        c3 = (sp - math.sin(sp))/(psi*sp)
    elif psi < -1e-6:
        sp = math.sqrt(-psi)
        c2 = (1 - math.cosh(sp))/psi
        c3 = (math.sinh(sp) - sp)/(sp**3)
    else:
        c2 = 0.5 - psi/24 + psi*psi/720
        c3 = 1/6 - psi/120 + psi*psi/5040
    return c2, c3

def kepler_propagate(mu, r0, v0, dt):
    r0n, v0n = norm(r0), norm(v0)
    rdotv = dot(r0, v0)
    alpha = -v0n*v0n/mu + 2/r0n           # 1/a
    if alpha > 1e-12:                      # ellipse
        chi = math.sqrt(mu)*dt*alpha
        if abs(alpha - 1.0) < 1e-9:
            chi *= 0.97
    elif abs(alpha) < 1e-12:               # parabola
        h = cross(r0, v0); p = dot(h, h)/mu
        s_ = 0.5*math.atan2(1.0, 3*math.sqrt(mu/p**3)*dt)
        w = math.atan(math.tan(s_)**(1/3))
        chi = math.sqrt(p)*2/math.tan(2*w)
    else:                                  # hyperbola
        a = 1/alpha
        chi = (math.copysign(1, dt)*math.sqrt(-a) *
               math.log(-2*mu*alpha*dt /
                        (rdotv + math.copysign(1, dt)*math.sqrt(-mu*a)*(1 - r0n*alpha))))
    for _ in range(200):
        psi = chi*chi*alpha
        c2, c3 = stumpff_c2c3(psi)
        r = (chi*chi*c2 + rdotv/math.sqrt(mu)*chi*(1 - psi*c3) + r0n*(1 - psi*c2))
        chi_new = chi + (math.sqrt(mu)*dt - chi**3*c3 - rdotv/math.sqrt(mu)*chi*chi*c2
                         - r0n*chi*(1 - psi*c3)) / r
        if abs(chi_new - chi) < 1e-12:
            chi = chi_new
            break
        chi = chi_new
    psi = chi*chi*alpha
    c2, c3 = stumpff_c2c3(psi)
    r = (chi*chi*c2 + rdotv/math.sqrt(mu)*chi*(1 - psi*c3) + r0n*(1 - psi*c2))
    f = 1 - chi*chi/r0n*c2
    g = dt - chi**3/math.sqrt(mu)*c3
    gdot = 1 - chi*chi/r*c2
    fdot = math.sqrt(mu)/(r*r0n)*chi*(psi*c3 - 1)
    rv = add(scale(r0, f), scale(v0, g))
    vv = add(scale(r0, fdot), scale(v0, gdot))
    return rv, vv
