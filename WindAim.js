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
var accDXField = null;
var accDYField = null;
var accFieldsTried = false;

var RAD = 180 / Math.PI;

client.registerModule(MOD, -1, "Combat", false);
client.registerIcon(MOD, 0xf05b);
client.describeModule(MOD,
    "Aim at the closest point on the hitbox.\n\n" +
    "- **WindMouse**: curved human-like path\n" +
    "- **Lock**: snap onto the box\n" +
    "- **Dynamic**: raise mouse sense while acquiring, slow it on the box\n" +
    "- **Hit Lock**: Smart keeps the last player you hit"
);

client.registerMode(MOD, "Mode", "WindMouse", "WindMouse", "Lock", "Dynamic");
client.registerSlider(MOD, "Speed", 10, 1, 90, 0.5);
client.registerSlider(MOD, "Range", 6, 1, 64, 0.5);
client.registerMultiSelectDefault(MOD, "Targets", ["Players"], "Players", "Living", "Monsters");
client.registerMode(MOD, "Select", "Angle", "Angle", "Distance", "Smart");
try {
    client.appendMode(MOD + ":Select", "Smart");
} catch (e) {}
client.registerSlider(MOD, "Hit Lock", 0.5, 0, 2, 0.05);
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
var predCache = { id: -1, tick: -1, vx: 0, vy: 0, vz: 0, ticks: 0, air: false };
var lastYaw = 0;
var lastPitch = 0;
var senseReady = false;
var cachedTargetId = -1;
var acquired = false;
var latched = false;
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
var destSmooth = { yaw: 0, pitch: 0, ready: false };
var stickyAim = null;
var stickyBoxC = null;
var carryYaw = 0;
var carryPitch = 0;
var carryReady = false;
var hitLockId = -1;
var hitLockUntil = 0;
var dynSYaw = 1;
var dynSPitch = 1;

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
    predCache = { id: -1, tick: -1, vx: 0, vy: 0, vz: 0, ticks: 0, air: false };
    senseReady = false;
    cachedTargetId = -1;
    acquired = false;
    latched = false;
    flick = { rolled: false, on: false, phase: 0, oy: 0, op: 0 };
    debugBox = null;
    destSmooth = { yaw: 0, pitch: 0, ready: false };
    stickyAim = null;
    stickyBoxC = null;
    carryReady = false;
    hitLockId = -1;
    hitLockUntil = 0;
}

function syncSense(player) {
    lastYaw = player.getYRot();
    lastPitch = player.getXRot();
    senseReady = true;
    dynSYaw = 1;
    dynSPitch = 1;
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

function mouseAccFields() {
    if (accFieldsTried) return !!accDXField;
    accFieldsTried = true;
    try {
        var cls = mc.mouseHandler.getClass();
        try {
            accDXField = cls.getDeclaredField("f_91516_");
            accDYField = cls.getDeclaredField("f_91517_");
        } catch (e) {
            accDXField = cls.getDeclaredField("accumulatedDX");
            accDYField = cls.getDeclaredField("accumulatedDY");
        }
        accDXField.setAccessible(true);
        accDYField.setAccessible(true);
        return true;
    } catch (e2) {
        accDXField = null;
        accDYField = null;
        return false;
    }
}

function clearVanillaMouse() {
    if (!mouseAccFields()) return;
    try {
        accDXField.setDouble(mc.mouseHandler, 0);
        accDYField.setDouble(mc.mouseHandler, 0);
    } catch (e) {}
}

function applyDynamic(player, destYaw, destPitch, onBox) {
    clearVanillaMouse();
    if (!senseReady) {
        lastYaw = player.getYRot();
        lastPitch = player.getXRot();
        senseReady = true;
        dynSYaw = 1;
        dynSPitch = 1;
    }

    var dYaw = steerYaw;
    var dPitch = steerPitch;
    var errYaw = wrapDeg(destYaw - lastYaw);
    var errPitch = destPitch - lastPitch;
    var intensity = n("Speed") / 10;
    if (intensity > 2.4) intensity = 2.4;

    var sYaw = axisScale(errYaw, dYaw, onBox, false, intensity);
    var sPitch = axisScale(errPitch, dPitch, onBox, true, intensity);
    dynSYaw = dynSYaw * 0.5 + sYaw * 0.5;
    dynSPitch = dynSPitch * 0.5 + sPitch * 0.5;
    sYaw = dynSYaw;
    sPitch = dynSPitch;
    var axis = client.getMode(MOD + ":Axis");
    if (axis === "X") sPitch = 1;
    if (axis === "Y") sYaw = 1;

    lastYaw += dYaw * sYaw;
    lastPitch = clamp(lastPitch + dPitch * sPitch, -90, 90);
    player.setYRot(lastYaw);
    player.setXRot(lastPitch);
    player.yRotO = lastYaw;
    player.xRotO = lastPitch;
}

function dynamicTick() {
    if (client.getMode(MOD + ":Mode") !== "Dynamic") return;
    if (!senseReady || !mc.player) return;
    if (b("Stop On Hit") && latched) {
        lastYaw = mc.player.getYRot();
        lastPitch = mc.player.getXRot();
        return;
    }
    if (!holdingAttack() || !currentTarget()) return;
    clearVanillaMouse();
    mc.player.setYRot(lastYaw);
    mc.player.setXRot(lastPitch);
    mc.player.yRotO = lastYaw;
    mc.player.xRotO = lastPitch;
}

// Full spring through normal tracking. Fade only on a real swipe so
// the curve stays intact; mixing with small mouse deltas made it stutter.
function assistMix(sYaw, sPitch) {
    var excess = hypot2(sYaw, sPitch) - 2.4;
    if (excess <= 0) return 1;
    return 1 / (1 + (excess / 5) * (excess / 5));
}

function blendWind(ox, oy, ovx, ovy, gain) {
    wind.x = ox + wrapDeg(wind.x - ox) * gain;
    wind.y = oy + (wind.y - oy) * gain;
    var keep = 0.4 + 0.6 * gain;
    wind.vx = (ovx + (wind.vx - ovx) * gain) * keep;
    wind.vy = (ovy + (wind.vy - ovy) * gain) * keep;
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

function followDest(yaw, pitch, dt) {
    if (!destSmooth.ready) {
        destSmooth.yaw = yaw;
        destSmooth.pitch = pitch;
        destSmooth.ready = true;
        return destSmooth;
    }
    var err = hypot2(wrapDeg(yaw - destSmooth.yaw), pitch - destSmooth.pitch);
    if (err < 0.3) {
        destSmooth.yaw = yaw;
        destSmooth.pitch = pitch;
        return destSmooth;
    }
    var k = 1 - Math.exp(-dt / 0.032);
    destSmooth.yaw += wrapDeg(yaw - destSmooth.yaw) * k;
    destSmooth.pitch += (pitch - destSmooth.pitch) * k;
    return destSmooth;
}

function expStep(destX, destY, speed, dt, noisy) {
    var t = speed / 90;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var tau = noisy ? 0.20 * (1 - t) + 0.042 * t : 0.11 * (1 - t) + 0.024 * t;
    var dx = wrapDeg(destX - wind.x);
    var dy = destY - wind.y;
    var dist = hypot2(dx, dy);
    if (noisy && dist > 14) {
        wind.wx = wind.wx * 0.9 + (Math.random() * 2 - 1) * 0.07;
        wind.wy = wind.wy * 0.9 + (Math.random() * 2 - 1) * 0.05;
    } else {
        wind.wx *= 0.86;
        wind.wy *= 0.86;
    }
    dx = wrapDeg(destX + wind.wx - wind.x);
    dy = destY + wind.wy - wind.y;
    dist = hypot2(dx, dy);
    if (dist < 0.28) {
        wind.x = destX + wind.wx;
        wind.y = clamp(destY + wind.wy, -90, 90);
        wind.vx = 0;
        wind.vy = 0;
        return;
    }
    var k = 1 - Math.exp(-dt / tau);
    if (dist < 1.6) k = Math.max(k, 0.42);
    wind.x += dx * k;
    wind.y = clamp(wind.y + dy * k, -90, 90);
    wind.vx = dt > 1e-4 ? dx * k / dt : 0;
    wind.vy = dt > 1e-4 ? dy * k / dt : 0;
}

function windStep(destX, destY, speed, dt) {
    expStep(destX, destY, speed, dt, true);
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
    expStep(destX, destY, speed, dt, false);
}

function smoothPred(entity, pt) {
    if (!b("Predict")) return null;
    return predictPos(entity, pt);
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
    if (pred) {
        return {
            dx: pred.x - entity.getX(),
            dy: pred.y - entity.getY(),
            dz: pred.z - entity.getZ()
        };
    }
    if (pt == null) return { dx: 0, dy: 0, dz: 0 };
    return {
        dx: (entity.xo + (entity.getX() - entity.xo) * pt) - entity.getX(),
        dy: (entity.yo + (entity.getY() - entity.yo) * pt) - entity.getY(),
        dz: (entity.zo + (entity.getZ() - entity.zo) * pt) - entity.getZ()
    };
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
    var box = worldBox(entity, pt, pred);
    var closest = closestOnAABB(box, eyeX, eyeY, eyeZ);
    var cx = (box.minX + box.maxX) * 0.5;
    var cy = (box.minY + box.maxY) * 0.5;
    var cz = (box.minZ + box.maxZ) * 0.5;
    if (!stickyAim || !stickyBoxC) {
        stickyAim = closest;
        stickyBoxC = { x: cx, y: cy, z: cz };
        return closest;
    }
    stickyAim = {
        x: stickyAim.x + (cx - stickyBoxC.x),
        y: stickyAim.y + (cy - stickyBoxC.y),
        z: stickyAim.z + (cz - stickyBoxC.z)
    };
    stickyBoxC = { x: cx, y: cy, z: cz };
    stickyAim = closestOnAABB(box, stickyAim.x, stickyAim.y, stickyAim.z);
    var jump = hypot3(
        stickyAim.x - closest.x,
        stickyAim.y - closest.y,
        stickyAim.z - closest.z
    );
    var blend = 0;
    if (!latched && jump > 0.22) blend = jump > 0.7 ? 0.28 : 0.1;
    if (blend > 0) {
        stickyAim = {
            x: stickyAim.x + (closest.x - stickyAim.x) * blend,
            y: stickyAim.y + (closest.y - stickyAim.y) * blend,
            z: stickyAim.z + (closest.z - stickyAim.z) * blend
        };
        stickyAim = closestOnAABB(box, stickyAim.x, stickyAim.y, stickyAim.z);
    }
    return stickyAim;
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

function entityPing(entity) {
    var ping = 50;
    try {
        var conn = mc.getConnection();
        ping = conn.getPlayerInfo(mc.player.getUUID()).getLatency();
        if (Java.isType(entity, Player)) {
            var theirs = conn.getPlayerInfo(entity.getUUID()).getLatency();
            if (theirs > 0) ping = (ping + theirs) * 0.5;
        }
    } catch (e) {}
    if (ping < 20) ping = 20;
    if (ping > 250) ping = 250;
    return ping;
}

// Remote players often have xo == x between packets, while getDeltaMovement
// still has travel speed. Position delta can also spike when lerp catches up.
function sampleRaw(entity) {
    var dx = entity.getX() - entity.xo;
    var dy = entity.getY() - entity.yo;
    var dz = entity.getZ() - entity.zo;
    var mx = 0;
    var mz = 0;
    try {
        var mot = entity.getDeltaMovement();
        mx = mot.x;
        mz = mot.z;
    } catch (e) {}
    var onGround = false;
    try {
        onGround = !!entity.onGround();
    } catch (e2) {}
    if (onGround || Math.abs(dy) < 0.08) dy = 0;
    var posH = hypot2(dx, dz);
    var motH = hypot2(mx, mz);
    if (posH < 0.012 && motH < 0.02) {
        return { vx: 0, vy: 0, vz: 0, still: true, air: false };
    }
    var vx;
    var vz;
    if (posH < 0.012) {
        vx = mx;
        vz = mz;
    } else if (motH > 0.03 && posH > motH * 1.7 + 0.04) {
        vx = mx;
        vz = mz;
    } else {
        vx = dx;
        vz = dz;
    }
    var cap = 0.42;
    var h = hypot2(vx, vz);
    if (h > cap) {
        vx *= cap / h;
        vz *= cap / h;
    }
    var air = !onGround && Math.abs(dy) > 0.08;
    return { vx: vx, vy: dy, vz: vz, still: false, air: air };
}

function updateHist(entity, raw) {
    var id = entity.getId();
    var prev = motionHist[id];
    var vx = raw.vx;
    var vy = raw.vy;
    var vz = raw.vz;
    var turn = 1;
    if (prev && !raw.still) {
        var mag0 = hypot2(prev.vx, prev.vz);
        var mag1 = hypot2(vx, vz);
        if (mag0 > 0.02 && mag1 > 0.02) {
            turn = (prev.vx * vx + prev.vz * vz) / (mag0 * mag1);
        }
        if (turn > 0.25) {
            vx = prev.vx * 0.4 + vx * 0.6;
            vz = prev.vz * 0.4 + vz * 0.6;
            vy = prev.vy * 0.4 + vy * 0.6;
        }
    }
    motionHist[id] = {
        vx: vx,
        vy: vy,
        vz: vz,
        turn: turn,
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

function velocityFor(entity) {
    var tick = mc.player.tickCount;
    if (predCache.id === entity.getId() && predCache.tick === tick) {
        return predCache;
    }
    var raw = sampleRaw(entity);
    var hist = updateHist(entity, raw);
    var ticks = 0;
    if (!raw.still) {
        ticks = 1 + entityPing(entity) / 60;
        if (hist.turn < 0.15) ticks *= 0.35;
        else if (hist.turn < 0.5) ticks *= 0.65;
        if (latched) ticks *= 0.5;
        if (ticks < 0.8) ticks = 0.8;
        if (ticks > 4) ticks = 4;
    }
    predCache = {
        id: entity.getId(),
        tick: tick,
        vx: raw.still ? 0 : hist.vx,
        vy: raw.still ? 0 : hist.vy,
        vz: raw.still ? 0 : hist.vz,
        ticks: ticks,
        air: raw.air
    };
    return predCache;
}

function predictPos(entity, pt) {
    if (pt == null || isNaN(pt)) pt = 1;
    if (pt < 0) pt = 0;
    if (pt > 1) pt = 1;
    var x = entity.xo + (entity.getX() - entity.xo) * pt;
    var y = entity.yo + (entity.getY() - entity.yo) * pt;
    var z = entity.zo + (entity.getZ() - entity.zo) * pt;
    var v = velocityFor(entity);
    if (v.ticks <= 0) return { x: x, y: y, z: z };
    x += v.vx * v.ticks;
    z += v.vz * v.ticks;
    if (v.air) {
        var vy = v.vy;
        var n = Math.floor(v.ticks);
        var frac = v.ticks - n;
        var i;
        for (i = 0; i < n; i++) {
            vy = (vy - 0.08) * 0.98;
            y += vy;
        }
        if (frac > 0) {
            vy = (vy - 0.08) * 0.98;
            y += vy * frac;
        }
    } else {
        y += v.vy * v.ticks;
    }
    return { x: x, y: y, z: z };
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
    if (hitLockId !== -1 && System.nanoTime() < hitLockUntil) {
        var locked = mc.level.getEntity(hitLockId);
        var lockPt = stillValidCheap(locked, player, 40, lookYaw, lookPitch);
        if (lockPt && (!b("Walls") || !wallBetween(eyeX, eyeY, eyeZ, lockPt.x, lockPt.y, lockPt.z))) {
            return locked;
        }
    } else {
        hitLockId = -1;
        hitLockUntil = 0;
    }
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
        senseReady = false;
        acquired = false;
        latched = false;
        destSmooth.ready = false;
        stickyAim = null;
        stickyBoxC = null;
        carryReady = false;
        resetFlick();
    }

    var pred = smoothPred(target, pt);
    if (b("Predict Box") && pred) {
        var pb = worldBox(target, pt, pred);
        debugBox = new AABB(pb.minX, pb.minY, pb.minZ, pb.maxX, pb.maxY, pb.maxZ);
    } else {
        debugBox = null;
    }
    var eye = lerpEntity(player, pt);
    var eyeY = eye.y + player.getEyeHeight();
    var hit = aimPoint(target, eye.x, eyeY, eye.z, pt, pred);
    var onBox = lookOnBox(player, target, pt, null, 0);
    if (onBox) {
        latched = true;
        acquired = true;
    } else if (latched && !lookOnBox(player, target, pt, null, 0.22)) {
        latched = false;
    }
    var mode = client.getMode(MOD + ":Mode");

    if (mode === "Dynamic") {
        if (b("Stop On Hit") && latched) return;
        var rotD = rotationTo(eye.x, eyeY, eye.z, hit.x, hit.y, hit.z);
        applyDynamic(player, rotD.yaw, rotD.pitch, onBox);
        return;
    }

    var rot = rotationTo(eye.x, eyeY, eye.z, hit.x, hit.y, hit.z);

    if (!wind) resetWind(player.getYRot(), player.getXRot());
    startOvershoot(rot.yaw, rot.pitch);

    var skippingStop = flick.on && flick.phase === 0;
    if (skippingStop) {
        latched = false;
        carryReady = false;
    }

    var axis = client.getMode(MOD + ":Axis");
    var dy = steerYaw;
    var dp = steerPitch;
    if (axis === "Y") dy = 0;
    if (axis === "X") dp = 0;

    if (!latched) carryReady = false;

    if (b("Stop On Hit") && latched && !skippingStop) {
        if (flick.on) flick.on = false;
        if (!carryReady) {
            carryYaw = rot.yaw;
            carryPitch = rot.pitch;
            carryReady = true;
        } else {
            wind.x += wrapDeg(rot.yaw - carryYaw);
            wind.y = clamp(wind.y + (rot.pitch - carryPitch), -90, 90);
            carryYaw = rot.yaw;
            carryPitch = rot.pitch;
        }
        wind.x += dy;
        wind.y = clamp(wind.y + dp, -90, 90);
        applyRot(player, wind.x, clamp(wind.y, -90, 90));
        return;
    }

    if (flick.on) destSmooth.ready = false;
    var aimed = flick.on ? rot : followDest(rot.yaw, rot.pitch, dt);
    var destYaw = wind.x + wrapDeg(aimed.yaw - wind.x);
    var destPitch = aimed.pitch;
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

    var gain = assistMix(dy, dp);
    var ox = wind.x;
    var oy = wind.y;
    var ovx = wind.vx;
    var ovy = wind.vy;
    if (correcting || mode === "Lock") lockStep(destYaw, destPitch, n("Speed"), dt);
    else windStep(destYaw, destPitch, n("Speed"), dt);
    if (gain < 0.999) blendWind(ox, oy, ovx, ovy, gain);
    wind.x += dy;
    wind.y = clamp(wind.y + dp, -90, 90);
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
        dynamicTick();
    } catch (e) {
        cachedTargetId = -1;
        log("[WindAim] " + e);
    }
});

events.on("attackEntity", function (entity) {
    try {
        if (!client.isEnabled(MOD)) return;
        if (client.getMode(MOD + ":Select") !== "Smart") return;
        var dur = n("Hit Lock");
        if (dur <= 0) return;
        if (!entity || !Java.isType(entity, Player)) return;
        hitLockId = entity.getId();
        hitLockUntil = System.nanoTime() + dur * 1e9;
    } catch (e) {}
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
