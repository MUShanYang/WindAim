// WindAim — Combat aim module.
// Modes: WindMouse (curved) / Lock (snap) / Dynamic (scale mouse sense per axis).

var MOD = "WindAim";
var RANGE = 6;
var FOV = 90;

var LivingEntity = Java.type("net.minecraft.world.entity.LivingEntity");
var Player = Java.type("net.minecraft.world.entity.player.Player");
var Monster = Java.type("net.minecraft.world.entity.monster.Monster");
var ArmorStand = Java.type("net.minecraft.world.entity.decoration.ArmorStand");
var HitType = Java.type("net.minecraft.world.phys.HitResult$Type");
var System = Java.type("java.lang.System");

var SQRT3 = Math.sqrt(3);
var SQRT5 = Math.sqrt(5);
var RAD = 180 / Math.PI;

client.registerModule(MOD, -1, "Combat", false);
client.registerIcon(MOD, 0xf05b);
client.describeModule(MOD,
    "Aim at the closest point on the hitbox.\n\n" +
    "- **WindMouse**: curved human-like path\n" +
    "- **Lock**: snap onto the box\n" +
    "- **Dynamic**: raise mouse sense while acquiring, slow it on the box\n" +
    "- WindMouse/Lock do nothing while the crosshair is already on the box"
);

client.registerMode(MOD, "Mode", "WindMouse", "WindMouse", "Lock", "Dynamic");
client.registerSlider(MOD, "Speed", 10, 1, 20, 0.5);
client.registerMultiSelectDefault(MOD, "Targets", ["Players"], "Players", "Living", "Monsters");
client.registerBoolean(MOD, "Hold", true);
client.registerBoolean(MOD, "Skip Mining", true);

var wind = null;
var stickyId = -1;
var motionHist = {};
var lastNs = 0;
var predCache = { id: -1, tick: -1, pos: null };
var lastYaw = 0;
var lastPitch = 0;
var senseReady = false;

function n(label) {
    return client.getNumber(MOD + ":" + label);
}

function b(label) {
    return client.getBool(MOD + ":" + label);
}

function hasTargetType(name) {
    var sel = client.getMulti(MOD + ":Targets");
    if (!sel) return false;
    for (var i = 0; i < sel.length; i++) {
        if (sel[i] === name) return true;
    }
    return false;
}

function hypot2(a, c) {
    return Math.sqrt(a * a + c * c);
}

function hypot3(a, c, d) {
    return Math.sqrt(a * a + c * c + d * d);
}

function wrapDeg(a) {
    a = a % 360;
    if (a >= 180) a -= 360;
    if (a < -180) a += 360;
    return a;
}

function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function frameDt() {
    var now = System.nanoTime();
    var dt = lastNs === 0 ? 0.016 : (now - lastNs) / 1e9;
    lastNs = now;
    if (dt < 0.001) dt = 0.001;
    if (dt > 0.05) dt = 0.05;
    return dt;
}

function holdingAttack() {
    if (!b("Hold")) return true;
    try {
        if (mc.options.keyAttack.isDown()) return true;
    } catch (e) {}
    try {
        if (mc.mouseHandler.isLeftPressed()) return true;
    } catch (e) {}
    return false;
}

function isMining() {
    try {
        if (mc.gameMode && mc.gameMode.isDestroying()) return true;
    } catch (e) {}
    try {
        var hr = mc.hitResult;
        if (hr && hr.getType() === HitType.BLOCK && holdingAttack()) return true;
    } catch (e) {}
    return false;
}

function resetWind(yaw, pitch) {
    wind = {
        x: yaw,
        y: pitch,
        vx: 0,
        vy: 0,
        wx: 0,
        wy: 0
    };
}

function clearAim() {
    wind = null;
    stickyId = -1;
    predCache = { id: -1, tick: -1, pos: null };
    senseReady = false;
}

function syncSense(player) {
    lastYaw = player.getYRot();
    lastPitch = player.getXRot();
    senseReady = true;
}

function boxCenter(box) {
    return {
        x: (box.minX + box.maxX) * 0.5,
        y: (box.minY + box.maxY) * 0.5,
        z: (box.minZ + box.maxZ) * 0.5
    };
}

// Per-axis mouse scale. Same-sign delta vs error = moving toward the aim point.
// Yaw boosts harder for tracking; pitch sticks harder so it does not flick off.
function axisScale(error, delta, onBox, isPitch, intensity) {
    if (Math.abs(delta) < 0.0005) return 1;
    var toward = delta * error > 0;
    var absErr = Math.abs(error);

    if (onBox) {
        var stay = isPitch ? 0.16 : 0.22;
        var slide = isPitch ? 0.38 : 0.48;
        stay = clamp(stay / (0.55 + intensity * 0.12), 0.08, 0.28);
        slide = clamp(slide / (0.7 + intensity * 0.08), 0.22, 0.55);
        return toward ? slide : stay;
    }

    if (absErr > 42) return 1;
    var t = 1 - absErr / 42;
    t = t * t;
    if (toward) {
        var boost = (isPitch ? 0.45 : 0.85) * intensity * t;
        return clamp(1 + boost, 1, 2.4);
    }
    var resist = (isPitch ? 0.4 : 0.28) * intensity * t;
    return clamp(1 - resist, 0.25, 1);
}

function applyDynamic(player, destYaw, destPitch, onBox) {
    var yaw = player.getYRot();
    var pitch = player.getXRot();
    if (!senseReady) {
        syncSense(player);
        return;
    }

    var dYaw = wrapDeg(yaw - lastYaw);
    var dPitch = pitch - lastPitch;
    var errYaw = wrapDeg(destYaw - lastYaw);
    var errPitch = destPitch - lastPitch;
    var intensity = n("Speed") / 10;

    var sYaw = axisScale(errYaw, dYaw, onBox, false, intensity);
    var sPitch = axisScale(errPitch, dPitch, onBox, true, intensity);

    var outYaw = lastYaw + dYaw * sYaw;
    var outPitch = clamp(lastPitch + dPitch * sPitch, -90, 90);
    applyRot(player, outYaw, outPitch);
    lastYaw = outYaw;
    lastPitch = outPitch;
}

function windStep(destX, destY, speed, dt) {
    var G = 9;
    var W = 1.2;
    var D = 8;
    var tick = dt * 20;

    var dx = destX - wind.x;
    var dy = destY - wind.y;
    var dist = hypot2(dx, dy);
    if (dist < 0.01) {
        wind.x = destX;
        wind.y = destY;
        wind.vx *= 0.5;
        wind.vy *= 0.5;
        return;
    }

    if (dist < D) {
        var t = 1 - Math.exp(-speed * 0.45 * tick);
        if (t > 1) t = 1;
        wind.x += dx * t;
        wind.y += dy * t;
        wind.vx *= 0.6;
        wind.vy *= 0.6;
        wind.wx *= 0.6;
        wind.wy *= 0.6;
        return;
    }

    var wMag = Math.min(W, dist);
    wind.wx = wind.wx / SQRT3 + (Math.random() * 2 - 1) * wMag / SQRT5;
    wind.wy = wind.wy / SQRT3 + (Math.random() * 2 - 1) * wMag / SQRT5;
    wind.vx += (wind.wx + G * dx / dist) * tick;
    wind.vy += (wind.wy + G * dy / dist) * tick;
    var vMag = hypot2(wind.vx, wind.vy);
    if (vMag > speed && vMag > 1e-6) {
        wind.vx *= speed / vMag;
        wind.vy *= speed / vMag;
    }
    wind.x += wind.vx * tick;
    wind.y += wind.vy * tick;
}

function entityName(e) {
    try {
        if (Java.isType(e, Player)) return e.getGameProfile().getName();
    } catch (err) {}
    return e.getScoreboardName();
}

function stripCodes(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === "\u00a7" || c === "&") {
            i++;
            continue;
        }
        out += c;
    }
    return out;
}

function boxOffset(entity, pt, pred) {
    var dx = 0;
    var dy = 0;
    var dz = 0;
    if (pt != null) {
        dx += (entity.xo + (entity.getX() - entity.xo) * pt) - entity.getX();
        dy += (entity.yo + (entity.getY() - entity.yo) * pt) - entity.getY();
        dz += (entity.zo + (entity.getZ() - entity.zo) * pt) - entity.getZ();
    }
    if (pred) {
        dx += pred.x - entity.getX();
        dy += pred.y - entity.getY();
        dz += pred.z - entity.getZ();
    }
    return { dx: dx, dy: dy, dz: dz };
}

function worldBox(entity, pt, pred) {
    var box = entity.getBoundingBox();
    var o = boxOffset(entity, pt, pred);
    return {
        minX: box.minX + o.dx,
        minY: box.minY + o.dy,
        minZ: box.minZ + o.dz,
        maxX: box.maxX + o.dx,
        maxY: box.maxY + o.dy,
        maxZ: box.maxZ + o.dz
    };
}

function closestOnAABB(box, px, py, pz) {
    var pad = 0.08;
    var x0 = box.minX + pad;
    var x1 = box.maxX - pad;
    var y0 = box.minY + pad;
    var y1 = box.maxY - pad;
    var z0 = box.minZ + pad;
    var z1 = box.maxZ - pad;
    if (x0 > x1) {
        x0 = x1 = (box.minX + box.maxX) * 0.5;
    }
    if (y0 > y1) {
        y0 = y1 = (box.minY + box.maxY) * 0.5;
    }
    if (z0 > z1) {
        z0 = z1 = (box.minZ + box.maxZ) * 0.5;
    }
    return {
        x: clamp(px, x0, x1),
        y: clamp(py, y0, y1),
        z: clamp(pz, z0, z1)
    };
}

function aimPoint(entity, eyeX, eyeY, eyeZ, pt, pred) {
    return closestOnAABB(worldBox(entity, pt, pred), eyeX, eyeY, eyeZ);
}

function rayHitsAABB(ox, oy, oz, dx, dy, dz, box, maxDist) {
    var tmin = 0;
    var tmax = maxDist;

    function slab(origin, dir, mn, mx) {
        if (Math.abs(dir) < 1e-8) return origin >= mn && origin <= mx;
        var t1 = (mn - origin) / dir;
        var t2 = (mx - origin) / dir;
        if (t1 > t2) {
            var tmp = t1;
            t1 = t2;
            t2 = tmp;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        return tmin <= tmax;
    }

    if (!slab(ox, dx, box.minX, box.maxX)) return false;
    if (!slab(oy, dy, box.minY, box.maxY)) return false;
    if (!slab(oz, dz, box.minZ, box.maxZ)) return false;
    return tmax >= 0 && tmin <= maxDist;
}

function lookOnBox(player, entity, pt, pred) {
    var eye = lerpEntity(player, pt);
    var eyeY = eye.y + player.getEyeHeight();
    var look = player.getLookAngle();
    return rayHitsAABB(
        eye.x, eyeY, eye.z,
        look.x, look.y, look.z,
        worldBox(entity, pt, pred),
        RANGE + 2
    );
}

function lerpEntity(e, pt) {
    return {
        x: e.xo + (e.getX() - e.xo) * pt,
        y: e.yo + (e.getY() - e.yo) * pt,
        z: e.zo + (e.getZ() - e.zo) * pt
    };
}

function rotationTo(fromX, fromY, fromZ, toX, toY, toZ) {
    var dx = toX - fromX;
    var dy = toY - fromY;
    var dz = toZ - fromZ;
    var distXZ = hypot2(dx, dz);
    var yaw = Math.atan2(dz, dx) * RAD - 90;
    var pitch = -Math.atan2(dy, distXZ) * RAD;
    return { yaw: wrapDeg(yaw), pitch: clamp(pitch, -90, 90) };
}

function angleToPoint(player, x, y, z) {
    var dx = x - player.getX();
    var dy = y - player.getEyeY();
    var dz = z - player.getZ();
    var dist = hypot3(dx, dy, dz);
    if (dist < 1e-6) return 0;
    var look = player.getLookAngle();
    var dot = (look.x * dx + look.y * dy + look.z * dz) / dist;
    dot = clamp(dot, -1, 1);
    var ang = Math.acos(dot) * RAD;
    if (isNaN(ang)) return 180;
    return ang;
}

function observedMotion(entity) {
    return {
        vx: entity.getX() - entity.xo,
        vy: entity.getY() - entity.yo,
        vz: entity.getZ() - entity.zo
    };
}

function isStationary(mot) {
    var h = hypot2(mot.vx, mot.vz);
    return hypot3(mot.vx, mot.vy, mot.vz) < 0.03 || (h < 0.02 && Math.abs(mot.vy) < 0.08);
}

function updateHist(entity, mot) {
    var id = entity.getId();
    var prev = motionHist[id];
    var ax = 0;
    var ay = 0;
    var az = 0;
    if (prev) {
        ax = clamp(prev.ax * 0.5 + (mot.vx - prev.vx) * 0.5, -0.1, 0.1);
        ay = clamp(prev.ay * 0.5 + (mot.vy - prev.vy) * 0.5, -0.14, 0.14);
        az = clamp(prev.az * 0.5 + (mot.vz - prev.vz) * 0.5, -0.1, 0.1);
    }
    motionHist[id] = {
        vx: mot.vx,
        vy: mot.vy,
        vz: mot.vz,
        ax: ax,
        ay: ay,
        az: az,
        seen: true
    };
    return motionHist[id];
}

function pruneHist() {
    for (var k in motionHist) {
        if (!motionHist[k].seen) delete motionHist[k];
        else motionHist[k].seen = false;
    }
}

function predictPos(entity) {
    var tick = mc.player.tickCount;
    if (predCache.id === entity.getId() && predCache.tick === tick && predCache.pos) {
        return predCache.pos;
    }

    var x = entity.getX();
    var y = entity.getY();
    var z = entity.getZ();
    var mot = observedMotion(entity);
    if (isStationary(mot)) {
        motionHist[entity.getId()] = {
            vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, seen: true
        };
        predCache = { id: entity.getId(), tick: tick, pos: { x: x, y: y, z: z } };
        return predCache.pos;
    }

    var hist = updateHist(entity, mot);
    var vx = mot.vx;
    var vy = mot.vy;
    var vz = mot.vz;
    var speedH = hypot2(vx, vz);
    var ticks = clamp(Math.round(speedH * 16), 2, 8);
    var onGround = entity.onGround() || Math.abs(vy) < 0.08;
    var airborne = !onGround && Math.abs(vy) > 0.1;
    var maxKeep = Math.min(Math.max(speedH * 1.05, 0.05), 0.62);

    for (var i = 0; i < ticks; i++) {
        if (airborne) {
            vy = (vy - 0.08) * 0.98;
            vx *= 0.91;
            vz *= 0.91;
        } else {
            vx += hist.ax;
            vz += hist.az;
            vy = 0;
            var sp = hypot2(vx, vz);
            if (sp > maxKeep && sp > 1e-6) {
                vx *= maxKeep / sp;
                vz *= maxKeep / sp;
            }
        }
        x += vx;
        y += vy;
        z += vz;
    }
    predCache = { id: entity.getId(), tick: tick, pos: { x: x, y: y, z: z } };
    return predCache.pos;
}

function isWanted(entity) {
    if (!Java.isType(entity, LivingEntity)) return false;
    if (Java.isType(entity, ArmorStand)) return false;
    if (entity.getId() === mc.player.getId()) return false;
    if (mc.cameraEntity && entity.getId() === mc.cameraEntity.getId()) return false;
    if (!entity.isAlive() || entity.isDeadOrDying()) return false;
    if (entity.isSpectator()) return false;
    if (entity.getBbWidth() < 0.2) return false;

    var isPlayer = Java.isType(entity, Player);
    var isMonster = Java.isType(entity, Monster);
    if (isPlayer && hasTargetType("Players")) return true;
    if (isMonster && hasTargetType("Monsters")) return true;
    if (!isPlayer && hasTargetType("Living")) return true;
    return false;
}

function isFiltered(entity) {
    if (Java.isType(entity, Player)) {
        var name = entityName(entity);
        if (client.isFriend(name)) return true;
        if (stripCodes(name).length < 1) return true;
    }
    try {
        var myTeam = mc.player.getTeam();
        var theirTeam = entity.getTeam();
        if (myTeam && theirTeam && myTeam === theirTeam) return true;
    } catch (e) {}
    try {
        if (!mc.player.hasLineOfSight(entity)) return true;
    } catch (e) {}
    return false;
}

function listEntities() {
    try {
        return Java.from(mc.level.entitiesForRendering());
    } catch (e) {
        try {
            return Java.from(mc.level.players());
        } catch (e2) {
            return [];
        }
    }
}

function stillValid(e, player, slack) {
    if (!e || isFiltered(e) || !isWanted(e)) return false;
    var eyeX = player.getX();
    var eyeY = player.getEyeY();
    var eyeZ = player.getZ();
    var pt = aimPoint(e, eyeX, eyeY, eyeZ, 1, null);
    var dist = hypot3(pt.x - eyeX, pt.y - eyeY, pt.z - eyeZ);
    if (dist > RANGE || dist < 0.15) return false;
    if (angleToPoint(player, pt.x, pt.y, pt.z) > FOV * 0.5 + slack) return false;
    return true;
}

function pickTarget() {
    var player = mc.player;

    if (stickyId !== -1) {
        var held = mc.level.getEntity(stickyId);
        if (stillValid(held, player, 25)) return held;
    }

    var entities = listEntities();
    var best = null;
    var bestScore = 1e9;
    for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        if (!stillValid(e, player, 0)) continue;
        var hit = aimPoint(e, player.getX(), player.getEyeY(), player.getZ(), 1, null);
        var ang = angleToPoint(player, hit.x, hit.y, hit.z);
        if (ang < bestScore) {
            bestScore = ang;
            best = e;
        }
    }
    return best;
}

function applyRot(player, yaw, pitch) {
    player.setYRot(yaw);
    player.setXRot(pitch);
    player.yRotO = yaw;
    player.xRotO = pitch;
    client.setRotation(yaw, pitch, 180);
}

function onRender(partialTicks) {
    var dt = frameDt();
    if (!client.isEnabled(MOD)) return;
    if (!mc.player || !mc.level) return;
    if (!mc.mouseHandler.isMouseGrabbed()) {
        senseReady = false;
        return;
    }
    if (!holdingAttack()) {
        clearAim();
        syncSense(mc.player);
        return;
    }
    if (b("Skip Mining") && isMining()) {
        clearAim();
        syncSense(mc.player);
        return;
    }

    var pt = partialTicks;
    if (pt == null || isNaN(pt)) pt = 1;
    if (pt < 0) pt = 0;
    if (pt > 1) pt = 1;

    var player = mc.player;
    var target = pickTarget();
    if (!target) {
        clearAim();
        syncSense(player);
        return;
    }

    var id = target.getId();
    if (id !== stickyId) {
        stickyId = id;
        wind = null;
        senseReady = false;
    }

    var pred = predictPos(target);
    var onBox = lookOnBox(player, target, pt, pred);
    var eye = lerpEntity(player, pt);
    var eyeY = eye.y + player.getEyeHeight();
    var mode = client.getMode(MOD + ":Mode");

    if (mode === "Dynamic") {
        var aim;
        if (onBox) {
            aim = boxCenter(worldBox(target, pt, pred));
        } else {
            aim = aimPoint(target, eye.x, eyeY, eye.z, pt, pred);
        }
        var rotD = rotationTo(eye.x, eyeY, eye.z, aim.x, aim.y, aim.z);
        var dyaw = senseReady ? lastYaw : player.getYRot();
        applyDynamic(
            player,
            dyaw + wrapDeg(rotD.yaw - dyaw),
            rotD.pitch,
            onBox
        );
        return;
    }

    if (onBox) {
        wind = null;
        return;
    }

    var hit = aimPoint(target, eye.x, eyeY, eye.z, pt, pred);
    var rot = rotationTo(eye.x, eyeY, eye.z, hit.x, hit.y, hit.z);
    var destYaw = player.getYRot() + wrapDeg(rot.yaw - player.getYRot());
    var destPitch = rot.pitch;

    if (mode === "Lock") {
        applyRot(player, destYaw, destPitch);
        return;
    }

    if (!wind) resetWind(player.getYRot(), player.getXRot());
    destYaw = wind.x + wrapDeg(rot.yaw - wind.x);
    windStep(destYaw, destPitch, n("Speed"), dt);
    applyRot(player, wind.x, clamp(wind.y, -90, 90));
}

events.on("tick", function () {
    pruneHist();
});

events.on("render3d", function (partialTicks) {
    try {
        onRender(partialTicks);
    } catch (e) {
        log("[WindAim] " + e);
    }
});

events.on("disable", function (name) {
    if (name !== MOD) return;
    clearAim();
    motionHist = {};
    lastNs = 0;
    senseReady = false;
});
