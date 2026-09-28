// Minimal mock of the stable @minecraft/server 2.0.0 surface used by main.js.
export const EntityDamageCause = { entityAttack: "entityAttack" };

class Signal {
    constructor() { this.cbs = []; }
    subscribe(cb) { this.cbs.push(cb); return cb; }
    unsubscribe(cb) { this.cbs = this.cbs.filter((c) => c !== cb); }
    emit(ev) { for (const cb of this.cbs.slice()) cb(ev); }
}

export const harness = {
    tick: 0,
    players: [],
    entities: [],
    timers: [],
    intervals: [],
    nextId: 1,
    sounds: [],
    actionBars: [],
    messages: [],
    damages: [],
};

class Dimension {
    constructor(id) { this.id = id; }
    getEntities(opts = {}) {
        return harness.entities.filter((e) =>
            e.dimension.id === this.id &&
            (!opts.tags || opts.tags.every((t) => e.tags.has(t))));
    }
    spawnEntity(typeId, loc) {
        const e = new Ent(typeId, this, loc);
        harness.entities.push(e);
        return e;
    }
    spawnParticle() { /* no-op */ }
}

const dimensions = {
    "minecraft:overworld": new Dimension("minecraft:overworld"),
    "minecraft:nether": new Dimension("minecraft:nether"),
    "minecraft:the_end": new Dimension("minecraft:the_end"),
};

class Ent {
    constructor(typeId, dimension, location) {
        this.typeId = typeId;
        this.dimension = dimension;
        this.location = { ...location };
        this.id = String(harness.nextId++);
        this.tags = new Set();
        this.props = new Map();
        this.isValid = true;
        this.nameTag = "";
        this.effects = new Map();
        this.hp = 20;
    }
    addTag(t) { this.tags.add(t); }
    getDynamicProperty(k) { return this.props.get(k); }
    setDynamicProperty(k, v) { this.props.set(k, v); }
    remove() { this.isValid = false; harness.entities = harness.entities.filter((e) => e !== this); }
    teleport(loc) { this.location = { ...loc }; }
    getVelocity() { return { x: 0, y: this.vy ?? 0, z: 0 }; }
    getViewDirection() { return { x: 1, y: 0, z: 0 }; }
    getHeadLocation() { return { x: this.location.x, y: this.location.y + 1.6, z: this.location.z }; }
    getComponent(id) {
        if (id !== "health") return undefined;
        const self = this;
        return {
            get currentValue() { return self.hp; },
            get effectiveMax() {
                const b = self.effects.get("health_boost");
                return 20 + (b ? (b.amplifier + 1) * 4 : 0);
            },
            set effectiveMax(_v) { throw new TypeError("read only"); },
            setCurrentValue(v) { self.hp = v; return true; },
        };
    }
    addEffect(id, dur, opts = {}) { this.effects.set(id, { amplifier: opts.amplifier ?? 0, until: harness.tick + dur }); }
    getEffect(id) {
        const e = this.effects.get(id);
        if (!e) return undefined;
        if (e.until <= harness.tick) { this.effects.delete(id); return undefined; }
        return e;
    }
    removeEffect(id) { return this.effects.delete(id); }
    applyDamage(amount, opts) { harness.damages.push({ target: this.id, amount, opts }); return true; }
    runCommand() { return { successCount: 1 }; }
    playSound(id, o) { harness.sounds.push({ who: this.id, id, o }); }
    sendMessage(t) { harness.messages.push({ who: this.id, t }); }
}

class Player extends Ent {
    constructor(name) {
        super("minecraft:player", dimensions["minecraft:overworld"], { x: 0, y: 64, z: 0 });
        this.name = name;
        this.isSneaking = false;
        this.isOnGround = true;
        this.vy = 0;
        const self = this;
        this.onScreenDisplay = {
            setActionBar(t) { harness.actionBars.push({ who: self.id, t }); },
            setTitle() { /* no-op */ },
        };
    }
}
harness.Player = Player;

export const world = {
    afterEvents: {
        entityDie: new Signal(),
        entityHurt: new Signal(),
        entityHitEntity: new Signal(),
        playerSpawn: new Signal(),
        playerLeave: new Signal(),
        playerButtonInput: new Signal(),
    },
    beforeEvents: {},
    getPlayers() { return harness.players.filter((p) => p.isValid); },
    getDimension(id) { return dimensions[id]; },
};

export const system = {
    get currentTick() { return harness.tick; },
    run(cb) { harness.timers.push({ at: harness.tick, cb }); return harness.nextId++; },
    runTimeout(cb, t) { const id = harness.nextId++; harness.timers.push({ at: harness.tick + t, cb, id }); return id; },
    runInterval(cb, t) { const h = { cb, every: Math.max(1, t), next: harness.tick + Math.max(1, t), id: harness.nextId++ }; harness.intervals.push(h); return h.id; },
    clearRun(id) { harness.intervals = harness.intervals.filter((i) => i.id !== id); harness.timers = harness.timers.filter((t) => t.id !== id); },
    afterEvents: { scriptEventReceive: new Signal() },
};

export function advance(n = 1) {
    for (let i = 0; i < n; i++) {
        harness.tick++;
        const due = harness.timers.filter((t) => t.at <= harness.tick);
        harness.timers = harness.timers.filter((t) => t.at > harness.tick);
        for (const t of due) t.cb();
        for (const iv of harness.intervals.slice()) {
            if (harness.tick >= iv.next) { iv.next = harness.tick + iv.every; iv.cb(); }
        }
    }
}
