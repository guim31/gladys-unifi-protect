// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// Nothing risky, on purpose: the Integration API offers neither the recording
// mode nor the notifications of a camera, and the integration does not arm,
// disarm or silence anything. Two actions remain, both harmless and useful:
//   - refresh_snapshot: a fresh image of a camera, sent to Gladys, so the
//     next action ("send the camera image" in a message) sends what the
//     camera sees now;
//   - set_doorbell_message: the message of a doorbell screen ("Do not
//     disturb" at night, "Leave the package at the door" when away), for a
//     number of minutes or until changed, or cleared.
// Gladys applies the field defaults to scene actions; a failure throws, the
// scene logs it and carries on.
// -----------------------------------------------------------------------------

import { ACTION_TEXT, pick } from './texts.js';

// `message` options of set_doorbell_message (permanent once published) →
// the Protect message type (null clears the screen).
export const DOORBELL_MESSAGES = Object.freeze({
  do_not_disturb: 'DO_NOT_DISTURB',
  leave_package: 'LEAVE_PACKAGE_AT_DOOR',
  custom: 'CUSTOM_MESSAGE',
  clear: null,
});

// The doorbell screen shows 30 characters (uiprotect DoorbellText).
export const MAX_MESSAGE_LENGTH = 30;
export const MAX_MESSAGE_MINUTES = 1440;
export const DEFAULT_MESSAGE_MINUTES = 60;

/** Minutes from a scene field: an integer from 0 (until changed) to a day. */
export function parseMinutes(raw) {
  const minutes = Math.round(Number(String(raw ?? '').replace(',', '.')));
  if (!Number.isFinite(minutes)) {
    return DEFAULT_MESSAGE_MINUTES;
  }
  return Math.min(MAX_MESSAGE_MINUTES, Math.max(0, minutes));
}

export const SCENE_ACTIONS = {
  async refresh_snapshot(hub, { fields = {} }) {
    await hub.refreshSnapshot(fields.camera);
  },

  async set_doorbell_message(hub, { fields = {} }) {
    const key = Object.hasOwn(DOORBELL_MESSAGES, fields.message)
      ? fields.message
      : 'do_not_disturb';
    const type = DOORBELL_MESSAGES[key];
    const message = { type };
    if (type === 'CUSTOM_MESSAGE') {
      const text = typeof fields.text === 'string' ? fields.text.trim() : '';
      if (!text) {
        throw new Error(pick(ACTION_TEXT.customText, hub.language));
      }
      message.text = text.slice(0, MAX_MESSAGE_LENGTH);
    }
    if (type !== null) {
      const minutes = parseMinutes(fields.duration);
      message.resetAt = minutes > 0 ? hub.now() + minutes * 60_000 : null;
    }
    await hub.setDoorbellMessage(fields.doorbell, message);
  },
};
