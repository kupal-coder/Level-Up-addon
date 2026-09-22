export const formLog = { shown: [], respond: null };
export class ActionFormData {
    constructor() { this.buttons = []; }
    title(t) { this._title = t; return this; }
    body(b) { this._body = b; return this; }
    button(b) { this.buttons.push(b); return this; }
    show(player) {
        formLog.shown.push({ player: player.id, body: this._body, buttons: this.buttons.slice() });
        const r = formLog.respond ? formLog.respond(this, player) : { canceled: true, cancelationReason: "UserClosed" };
        return Promise.resolve(r);
    }
}
