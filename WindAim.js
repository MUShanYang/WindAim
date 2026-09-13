// WindAim — Combat aim module.
// Modes: WindMouse (curved) / Lock (snap) / Dynamic (scale mouse sense per axis).

var MOD = "WindAim";

var LivingEntity = Java.type("net.minecraft.world.entity.LivingEntity");
var Player = Java.type("net.minecraft.world.entity.player.Player");
var Monster = Java.type("net.minecraft.world.entity.monster.Monster");
var ArmorStand = Java.type("net.minecraft.world.entity.decoration.ArmorStand");
var SwordItem = Java.type("net.minecraft.world.item.SwordItem");
var AxeItem = Java.type("net.minecraft.world.item.AxeItem");
var PickaxeItem = Java.type("net.minecraft.world.item.PickaxeItem");
var ShovelItem = Java.type("net.minecraft.world.item.ShovelItem");
var HoeItem = Java.type("net.minecraft.world.item.HoeItem");
var HitType = Java.type("net.minecraft.world.phys.HitResult$Type");
var Vec3 = Java.type("net.minecraft.world.phys.Vec3");
var ClipContext = Java.type("net.minecraft.world.level.ClipContext");
var ClipBlock = Java.type("net.minecraft.world.level.ClipContext$Block");
var ClipFluid = Java.type("net.minecraft.world.level.ClipContext$Fluid");
var AABB = Java.type("net.minecraft.world.phys.AABB");
var System = Java.type("java.lang.System");
var GLFW = null;
try {
    GLFW = Java.type("org.lwjgl.glfw.GLFW");
} catch (e) {}

var RAD = 180 / Math.PI;

client.registerModule(MOD, -1, "Combat", false);
client.registerIcon(MOD, 0xf05b);
client.describeModule(MOD,
    "Aim at the closest point on the hitbox.\n\n" +
    "- **WindMouse**: curved human-like path\n" +
    "- **Lock**: snap onto the box\n" +
    "- **Dynamic**: raise mouse sense while acquiring, slow it on the box"
);

client.registerMode(MOD, "Mode", "WindMouse", "WindMouse", "Lock", "Dynamic");
client.registerSlider(MOD, "Speed", 10, 1, 90, 0.5);
client.registerSlider(MOD, "Range", 6, 1, 64, 0.5);
client.registerMultiSelectDefault(MOD, "Targets", ["Players"], "Players", "Living", "Monsters");
client.registerMode(MOD, "Select", "Angle", "Angle", "Distance", "Smart");
try {
    client.appendMode(MOD + ":Select", "Smart");
} catch (e) {}
client.registerSlider(MOD, "FOV", 90, 10, 360, 1);
client.registerMode(MOD, "Axis", "Both", "Both", "X", "Y");
client.registerBoolean(MOD, "Hold Attack", true);
client.registerMultiSelectDefault(MOD, "Tools", [], "Sword", "Axe", "Pickaxe", "Shovel", "Hoe");
client.registerBoolean(MOD, "Skip Mining", true);
client.registerBoolean(MOD, "Stop On Hit", true);
client.registerSlider(MOD, "Overshoot", 35, 0, 100, 1);
client.registerSlider(MOD, "Overshoot Dist", 8, 1, 40, 0.5);
client.registerBoolean(MOD, "Walls", true);
client.registerBoolean(MOD, "Predict", true);
client.registerBoolean(MOD, "Predict Box", true);
try {
    client.hideProperty(MOD + ":Show Predict");
} catch (e) {}
try {
    client.hideProperty(MOD + ":Pull Back");
} catch (e) {}

var wind = null;
var stickyId = -1;
var motionHist = {};
var lastNs = 0;
var predCache = { id: -1, tick: -1, pos: null };
var predSmooth = { id: -1, tick: -1, from: null, to: null };
var lastYaw = 0;
var lastPitch = 0;
var senseReady = false;
var cachedTargetId = -1;
var acquired = false;
var flick = { rolled: false, on: false, phase: 0, oy: 0, op: 0 };
var debugBox = null;
var wantPlayers = true;
var wantLiving = false;
var wantMonsters = false;
var lastMx = 0;
var lastMy = 0;
var mouseInit = false;
var rawYaw = 0;
var rawPitch = 0;
var rawReady = false;
var flickYawRate = 0;
var flickPitchRate = 0;
var steerYaw = 0;
var steerPitch = 0;

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

function mouseToDeg() {
    var s = 0.5;
    try {
        s = mc.options.sensitivity().get();
    } catch (e) {}
    if (s > 1) s = 1;
    if (s < 0) s = 0;
    var f = s * 0.6 + 0.2;
    return f * f * f * 8 * 0.15;
}

function sampleUserMouse(dt) {
    var mx;
    var my;
    try {
        mx = mc.mouseHandler.xpos();
        my = mc.mouseHandler.ypos();
    } catch (e) {
        steerYaw = 0;
        steerPitch = 0;
        return;
    }
    if (!mouseInit) {
        lastMx = mx;
        lastMy = my;
        mouseInit = true;
        steerYaw = 0;
        steerPitch = 0;
        return;
    }
    var pdx = mx - lastMx;
    var pdy = my - lastMy;
    lastMx = mx;
    lastMy = my;
    if (!mc.mouseHandler.isMouseGrabbed()) {
        flickYawRate *= 0.35;
        flickPitchRate *= 0.35;
        rawReady = false;
        steerYaw = 0;
        steerPitch = 0;
        return;
    }
    var invert = false;
    try {
        invert = !!mc.options.invertYMouse().get();
    } catch (e) {}
    var scale = mouseToDeg();
    var dyaw = pdx * scale;
    var dpitch = (invert ? -pdy : pdy) * scale;
    if (!rawReady && mc.player) {
        rawYaw = mc.player.getYRot();
        rawPitch = mc.player.getXRot();
        rawReady = true;
    }
    rawYaw += dyaw;
    rawPitch = clamp(rawPitch + dpitch, -90, 90);
    if (dt < 0.001) dt = 0.001;
    flickYawRate = flickYawRate * 0.62 + (dyaw / dt) * 0.38;
    flickPitchRate = flickPitchRate * 0.62 + (dpitch / dt) * 0.38;
    steerYaw = dyaw;
    steerPitch = dpitch;
}

function lookDir(yaw, pitch) {
    var yr = yaw * Math.PI / 180;
    var pr = pitch * Math.PI / 180;
    var cp = Math.cos(pr);
    return {
        x: -Math.sin(yr) * cp,
        y: -Math.sin(pr),
        z: Math.cos(yr) * cp
    };
}

function angleFromLook(yaw, pitch, eyeX, eyeY, eyeZ, x, y, z) {
    var dx = x - eyeX;
    var dy = y - eyeY;
    var dz = z - eyeZ;
    var dist = hypot3(dx, dy, dz);
    if (dist < 1e-6) return 0;
    var look = lookDir(yaw, pitch);
    var dot = (look.x * dx + look.y * dy + look.z * dz) / dist;
    dot = clamp(dot, -1, 1);
    var ang = Math.acos(dot) * RAD;
    if (isNaN(ang)) return 180;
    return ang;
}

function holdingAttack() {
    if (!b("Hold Attack")) return true;
    // KeyMapping.isDown() can stay true after release (clickCount / consumeClick).
    // Read the bound attack key from GLFW so Hold follows the physical button.
    try {
        if (!GLFW) return !!mc.mouseHandler.isLeftPressed();
        var handle = mc.getWindow().getWindow();
        var k = mc.options.keyAttack.getKey();
        var name = k.getName();
        if (name && name.indexOf("mouse") >= 0) {
            return GLFW.glfwGetMouseButton(handle, k.getValue()) === 1;
        }
        return GLFW.glfwGetKey(handle, k.getValue()) === 1;
    } catch (e) {
        try {
            return !!mc.mouseHandler.isLeftPressed();
        } catch (e2) {
            return false;
        }
    }
}

function holdingTool() {
    var sel = client.getMulti(MOD + ":Tools");
    if (!sel || sel.length === 0) return true;
    try {
        var item = mc.player.getMainHandItem().getItem();
        for (var i = 0; i < sel.length; i++) {
            var t = sel[i];
            if (t === "Sword" && Java.isType(item, SwordItem)) return true;
            if (t === "Axe" && Java.isType(item, AxeItem)) return true;
            if (t === "Pickaxe" && Java.isType(item, PickaxeItem)) return true;
            if (t === "Shovel" && Java.isType(item, ShovelItem)) return true;
            if (t === "Hoe" && Java.isType(item, HoeItem)) return true;
        }
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
    cachedTargetId = -1;
    acquired = false;
    flick = { rolled: false, on: false, phase: 0, oy: 0, op: 0 };
    debugBox = null;
    predSmooth = { id: -1, tick: -1, from: null, to: null };
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
    if (intensity > 2.4) intensity = 2.4;

    var sYaw = axisScale(errYaw, dYaw, onBox, false, intensity);
    var sPitch = axisScale(errPitch, dPitch, onBox, true, intensity);
    var axis = client.getMode(MOD + ":Axis");
    if (axis === "X") sPitch = 1;
    if (axis === "Y") sYaw = 1;

    var outYaw = lastYaw + dYaw * sYaw;
    var outPitch = clamp(lastPitch + dPitch * sPitch, -90, 90);
    applyRot(player, outYaw, outPitch);
    lastYaw = outYaw;
    lastPitch = outPitch;
}

function windStep(destX, destY, speed, dt) {
    var dx = destX - wind.x;
    var dy = destY - wind.y;
    var dist = hypot2(dx, dy);
    var spd = hypot2(wind.vx, wind.vy);
    if (dist < 0.02 && spd < 0.8) {
        wind.x = destX;
        wind.y = destY;
        wind.vx = 0;
        wind.vy = 0;
        wind.wx = 0;
        wind.wy = 0;
        return;
    }

    if (dist > 15) {
        wind.wx = wind.wx * 0.9 + (Math.random() * 2 - 1) * 0.25;
        wind.wy = wind.wy * 0.9 + (Math.random() * 2 - 1) * 0.25;
    } else {
        wind.wx *= 0.82;
        wind.wy *= 0.82;
    }

    var omega = 5 + speed * 0.85;
    wind.vx += (dx * omega * omega + wind.wx) * dt - 2 * omega * wind.vx * dt;
    wind.vy += (dy * omega * omega + wind.wy) * dt - 2 * omega * wind.vy * dt;
    var maxV = 28 + speed * 22;
    spd = hypot2(wind.vx, wind.vy);
    if (spd > maxV && spd > 1e-6) {
        wind.vx *= maxV / spd;
        wind.vy *= maxV / spd;
    }
    wind.x += wind.vx * dt;
    wind.y += wind.vy * dt;
}

function resetFlick() {
    flick = { rolled: false, on: false, phase: 0, oy: 0, op: 0 };
}

function startOvershoot(trueYaw, truePitch) {
    if (flick.rolled) return;
    flick.rolled = true;
    var chance = n("Overshoot");
    if (chance <= 0 || Math.random() * 100 >= chance) return;
    var dy = wrapDeg(trueYaw - wind.x);
    var dp = truePitch - wind.y;
    var len = hypot2(dy, dp);
    if (len < 5) return;
    var extra = n("Overshoot Dist") * (0.75 + Math.random() * 0.5);
    flick.on = true;
    flick.phase = 0;
    flick.oy = wind.x + dy / len * (len + extra);
    flick.op = clamp(wind.y + dp / len * (len + extra), -89, 89);
}

function lockStep(destX, destY, speed, dt) {
    var dx = destX - wind.x;
    var dy = destY - wind.y;
    var dist = hypot2(dx, dy);
    var spd = hypot2(wind.vx, wind.vy);
    if (dist < 0.015 && spd < 0.6) {
        wind.x = destX;
        wind.y = destY;
        wind.vx = 0;
        wind.vy = 0;
        return;
    }
    var omega = 10 + speed * 1.35;
    wind.vx += dx * omega * omega * dt - 2 * omega * wind.vx * dt;
    wind.vy += dy * omega * omega * dt - 2 * omega * wind.vy * dt;
    var maxV = 50 + speed * 28;
    spd = hypot2(wind.vx, wind.vy);
    if (spd > maxV && spd > 1e-6) {
        wind.vx *= maxV / spd;
        wind.vy *= maxV / spd;
    }
    wind.x += wind.vx * dt;
    wind.y += wind.vy * dt;
}

function smoothPred(entity, pt) {
    if (!b("Predict")) return null;
    var to = predictPos(entity);
    var tick = mc.player.tickCount;
    if (predSmooth.id !== entity.getId()) {
        predSmooth.id = entity.getId();
        predSmooth.tick = tick;
        predSmooth.from = to;
        predSmooth.to = to;
        return to;
    }
    if (predSmooth.tick !== tick) {
        predSmooth.from = predSmooth.to;
        predSmooth.to = to;
        predSmooth.tick = tick;
    }
    var a = predSmooth.from;
    var c = predSmooth.to;
    if (!a || !c) return to;
    if (pt < 0) pt = 0;
    if (pt > 1) pt = 1;
    return {
        x: a.x + (c.x - a.x) * pt,
        y: a.y + (c.y - a.y) * pt,
        z: a.z + (c.z - a.z) * pt
    };
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

function lookOnBox(player, entity, pt, pred, inflate) {
    var eye = lerpEntity(player, pt);
    var eyeY = eye.y + player.getEyeHeight();
    var look = player.getLookAngle();
    var box = worldBox(entity, pt, pred);
    if (inflate) {
        box.minX -= inflate;
        box.minY -= inflate;
        box.minZ -= inflate;
        box.maxX += inflate;
        box.maxY += inflate;
        box.maxZ += inflate;
    }
    return rayHitsAABB(
        eye.x, eyeY, eye.z,
        look.x, look.y, look.z,
        box,
        n("Range") + 2
    );
}

function yieldMouse(player) {
    if (!wind) return;
    wind.x = player.getYRot();
    wind.y = player.getXRot();
    wind.vx = 0;
    wind.vy = 0;
    wind.wx = 0;
    wind.wy = 0;
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
    return false;
}

function wallBetween(x0, y0, z0, x1, y1, z1) {
    try {
        var from = new Vec3(x0, y0, z0);
        var to = new Vec3(x1, y1, z1);
        var hit = mc.level.clip(new ClipContext(from, to, ClipBlock.COLLIDER, ClipFluid.NONE, mc.player));
        if (hit.getType() === HitType.MISS) return false;
        var loc = hit.getLocation();
        var hitDist = hypot3(loc.x - x0, loc.y - y0, loc.z - z0);
        var aimDist = hypot3(x1 - x0, y1 - y0, z1 - z0);
        return hitDist + 0.08 < aimDist;
    } catch (e) {
        return false;
    }
}

function refreshWanted() {
    wantPlayers = hasTargetType("Players");
    wantLiving = hasTargetType("Living");
    wantMonsters = hasTargetType("Monsters");
}

function listEntities() {
    if (wantPlayers && !wantLiving && !wantMonsters) {
        try {
            return Java.from(mc.level.players());
        } catch (e) {}
    }
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

function stillValidCheap(e, player, slack, lookYaw, lookPitch) {
    if (!e || isFiltered(e) || !isWanted(e)) return false;
    var eyeX = player.getX();
    var eyeY = player.getEyeY();
    var eyeZ = player.getZ();
    var pt = aimPoint(e, eyeX, eyeY, eyeZ, 1, null);
    var dist = hypot3(pt.x - eyeX, pt.y - eyeY, pt.z - eyeZ);
    if (dist > n("Range") || dist < 0.15) return false;
    var view = n("FOV");
    if (view < 360) {
        var ang = lookYaw != null
            ? angleFromLook(lookYaw, lookPitch, eyeX, eyeY, eyeZ, pt.x, pt.y, pt.z)
            : angleToPoint(player, pt.x, pt.y, pt.z);
        if (ang > view * 0.5 + slack) return false;
    }
    return pt;
}

function pickTarget() {
    var player = mc.player;
    var select = client.getMode(MOD + ":Select");
    refreshWanted();

    if (select === "Smart") return pickSmart(player);

    if (stickyId !== -1 && select !== "Angle") {
        var held = mc.level.getEntity(stickyId);
        var heldPt = stillValidCheap(held, player, 25);
        if (heldPt) {
            if (!b("Walls") || !wallBetween(player.getX(), player.getEyeY(), player.getZ(), heldPt.x, heldPt.y, heldPt.z)) {
                return held;
            }
        }
    }

    var entities = listEntities();
    var ranked = [];
    for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        var hit = stillValidCheap(e, player, 0);
        if (!hit) continue;
        var score = select === "Distance"
            ? hypot3(hit.x - player.getX(), hit.y - player.getEyeY(), hit.z - player.getZ())
            : angleToPoint(player, hit.x, hit.y, hit.z);
        ranked.push({ e: e, score: score, hit: hit });
    }
    ranked.sort(function (a, c) {
        return a.score - c.score;
    });

    if (ranked.length === 0) return null;
    if (!b("Walls")) return ranked[0].e;

    var limit = ranked.length < 8 ? ranked.length : 8;
    var eyeX = player.getX();
    var eyeY = player.getEyeY();
    var eyeZ = player.getZ();
    for (var j = 0; j < limit; j++) {
        var cand = ranked[j];
        if (!wallBetween(eyeX, eyeY, eyeZ, cand.hit.x, cand.hit.y, cand.hit.z)) return cand.e;
    }
    return null;
}

function pickSmart(player) {
    var lookYaw = rawReady ? rawYaw : player.getYRot();
    var lookPitch = rawReady ? rawPitch : player.getXRot();
    var flickLen = hypot2(flickYawRate, flickPitchRate);
    var eyeX = player.getX();
    var eyeY = player.getEyeY();
    var eyeZ = player.getZ();
    var entities = listEntities();
    var ahead = 0.18;
    var predYaw = lookYaw + flickYawRate * ahead;
    var predPitch = clamp(lookPitch + flickPitchRate * ahead, -90, 90);
    var flicking = flickLen > 40;
    var ranked = [];

    for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        var hit = stillValidCheap(e, player, flicking ? 20 : 0, lookYaw, lookPitch);
        if (!hit) continue;
        var dist = hypot3(hit.x - eyeX, hit.y - eyeY, hit.z - eyeZ);
        if (!flicking) {
            ranked.push({ e: e, score: dist, hit: hit, smart: false });
            continue;
        }
        var rot = rotationTo(eyeX, eyeY, eyeZ, hit.x, hit.y, hit.z);
        var errY = wrapDeg(rot.yaw - lookYaw);
        var errP = rot.pitch - lookPitch;
        var errNow = hypot2(errY, errP);
        var errPred = hypot2(wrapDeg(rot.yaw - predYaw), rot.pitch - predPitch);
        var align = 0;
        if (errNow > 0.05) {
            align = (flickYawRate * errY + flickPitchRate * errP) / (flickLen * errNow);
        }
        var box = worldBox(e, 1, null);
        var dir = lookDir(predYaw, predPitch);
        var onPath = align > 0.42 && errPred < errNow + 1;
        var rayHit = rayHitsAABB(eyeX, eyeY, eyeZ, dir.x, dir.y, dir.z, box, n("Range") + 2);
        if (onPath || rayHit) ranked.push({ e: e, score: dist, hit: hit, smart: true });
    }

    ranked.sort(function (a, c) {
        return a.score - c.score;
    });

    function firstVisible(list) {
        if (list.length === 0) return null;
        if (!b("Walls")) return list[0].e;
        var lim = list.length < 8 ? list.length : 8;
        for (var j = 0; j < lim; j++) {
            var cand = list[j];
            if (!wallBetween(eyeX, eyeY, eyeZ, cand.hit.x, cand.hit.y, cand.hit.z)) return cand.e;
        }
        return null;
    }

    if (flicking) {
        var flicked = [];
        for (var k = 0; k < ranked.length; k++) {
            if (ranked[k].smart) flicked.push(ranked[k]);
        }
        var chosen = firstVisible(flicked);
        if (chosen) return chosen;
    }

    if (stickyId !== -1) {
        var held = mc.level.getEntity(stickyId);
        var heldPt = stillValidCheap(held, player, 25, lookYaw, lookPitch);
        if (heldPt && (!b("Walls") || !wallBetween(eyeX, eyeY, eyeZ, heldPt.x, heldPt.y, heldPt.z))) {
            return held;
        }
    }

    ranked.sort(function (a, c) {
        var aa = angleFromLook(lookYaw, lookPitch, eyeX, eyeY, eyeZ, a.hit.x, a.hit.y, a.hit.z);
        var bb = angleFromLook(lookYaw, lookPitch, eyeX, eyeY, eyeZ, c.hit.x, c.hit.y, c.hit.z);
        return aa - bb;
    });
    return firstVisible(ranked);
}

function currentTarget() {
    if (cachedTargetId === -1 || !mc.level) return null;
    return mc.level.getEntity(cachedTargetId);
}

function applyRot(player, yaw, pitch) {
    var axis = client.getMode(MOD + ":Axis");
    if (axis === "X") pitch = player.getXRot();
    if (axis === "Y") yaw = player.getYRot();
    player.setYRot(yaw);
    player.setXRot(pitch);
    player.yRotO = yaw;
    player.xRotO = pitch;
}

function onRender(partialTicks) {
    var dt = frameDt();
    if (mc.player && mc.level) sampleUserMouse(dt);
    if (!holdingAttack()) rawReady = false;
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
    if (!holdingTool()) {
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
    var target = currentTarget();
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
        acquired = false;
        resetFlick();
    }

    var pred = smoothPred(target, pt);
    if (b("Predict Box") && pred) {
        var pb = worldBox(target, pt, pred);
        debugBox = new AABB(pb.minX, pb.minY, pb.minZ, pb.maxX, pb.maxY, pb.maxZ);
    } else {
        debugBox = null;
    }
    var onBox = lookOnBox(player, target, pt, null, 0.12);
    if (onBox) acquired = true;
    var eye = lerpEntity(player, pt);
    var eyeY = eye.y + player.getEyeHeight();
    var mode = client.getMode(MOD + ":Mode");

    if (mode === "Dynamic") {
        if (hypot2(steerYaw, steerPitch) > 0.5) {
            syncSense(player);
            return;
        }
        if (b("Stop On Hit") && onBox) {
            syncSense(player);
            return;
        }
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

    var hit = aimPoint(target, eye.x, eyeY, eye.z, pt, pred);
    var rot = rotationTo(eye.x, eyeY, eye.z, hit.x, hit.y, hit.z);
    var destPitch = rot.pitch;

    if (!wind) resetWind(player.getYRot(), player.getXRot());
    startOvershoot(rot.yaw, rot.pitch);

    var destYaw = wind.x + wrapDeg(rot.yaw - wind.x);
    destPitch = rot.pitch;
    var correcting = false;
    if (flick.on && flick.phase === 0) {
        destYaw = wind.x + wrapDeg(flick.oy - wind.x);
        destPitch = flick.op;
        var toFake = hypot2(wrapDeg(flick.oy - wind.x), flick.op - wind.y);
        if (toFake < 2.4 || (acquired && !onBox)) {
            flick.phase = 1;
        }
    }
    if (flick.on && flick.phase === 1) {
        correcting = true;
        destYaw = wind.x + wrapDeg(rot.yaw - wind.x);
        destPitch = rot.pitch;
        if (onBox && hypot2(wrapDeg(rot.yaw - wind.x), rot.pitch - wind.y) < 1.6) {
            flick.on = false;
        }
    }

    var axis = client.getMode(MOD + ":Axis");
    if (axis === "X") {
        destPitch = wind.y;
        wind.vy = 0;
        wind.wy = 0;
    }
    if (axis === "Y") {
        destYaw = wind.x;
        wind.vx = 0;
        wind.wx = 0;
    }

    var skippingStop = flick.on && flick.phase === 0;
    var userSteer = hypot2(steerYaw, steerPitch);
    if (userSteer > 0.5) {
        yieldMouse(player);
        return;
    }
    if (b("Stop On Hit") && onBox && !skippingStop) {
        yieldMouse(player);
        return;
    }

    if (correcting || mode === "Lock") lockStep(destYaw, destPitch, n("Speed"), dt);
    else windStep(destYaw, destPitch, n("Speed"), dt);
    wind.x += steerYaw;
    wind.y = clamp(wind.y + steerPitch, -90, 90);
    applyRot(player, wind.x, clamp(wind.y, -90, 90));
}

events.on("tick", function () {
    pruneHist();
    if (!client.isEnabled(MOD) || !mc.player || !mc.level) {
        cachedTargetId = -1;
        return;
    }
    try {
        var t = pickTarget();
        cachedTargetId = t ? t.getId() : -1;
        if (cachedTargetId !== -1) stickyId = cachedTargetId;
    } catch (e) {
        cachedTargetId = -1;
        log("[WindAim] " + e);
    }
});

events.on("render3d", function (partialTicks) {
    try {
        onRender(partialTicks);
        if (debugBox) render.drawBox(debugBox, 0xAA22FF88);
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
    mouseInit = false;
    rawReady = false;
    flickYawRate = 0;
    flickPitchRate = 0;
});
