import assert from "node:assert/strict";
import { test } from "node:test";

import { setCurveText } from "../dist/spine/curve.js";
import { parseDocument } from "../dist/spine/document.js";
import { validateDocument } from "../dist/spine/validate.js";

const fixture = {
  skeleton: { spine: "4.3.75" },
  bones: [{ name: "root" }, { name: "arm", parent: "root" }],
  animations: {
    swing: {
      bones: { arm: {
        rotate: [{ value: 0 }, { time: 1, value: 90 }],
        translate: [{ x: 2, y: 4 }, { time: 2, x: 10, y: 12 }],
      } },
    },
  },
};

function document(data = fixture) {
  return parseDocument("/tmp/curve-fixture.json", `${JSON.stringify(data, null, 2)}\n`);
}

test("Bézier controls expand into absolute time and value coordinates for each bone channel", () => {
  const result = setCurveText(document(), {
    kind: "set_curve", animation: "swing", bone: "arm", timelineType: "translate", time: 0,
    mode: "bezier", controls: [0.25, 0, 0.75, 1],
  });
  const edited = parseDocument("/tmp/curve-fixture.json", result.text);
  assert.deepEqual(edited.data.animations.swing.bones.arm.translate[0].curve, [0.5, 2, 1.5, 10, 0.5, 4, 1.5, 12]);
  assert.equal(result.summary.channels, 2);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(validateDocument(edited), []);
});

test("named easing presets expand to numeric Bézier controls without caller controls", () => {
  const expected = {
    ease_in: [0.42, 0, 1, 90],
    ease_out: [0, 0, 0.58, 90],
    ease_in_out: [0.42, 0, 0.58, 90],
  };
  for (const [mode, curve] of Object.entries(expected)) {
    const result = setCurveText(document(), {
      kind: "set_curve", animation: "swing", bone: "arm", timelineType: "rotate", time: 0, mode,
    });
    assert.deepEqual(JSON.parse(result.text).animations.swing.bones.arm.rotate[0].curve, curve);
    assert.deepEqual(validateDocument(parseDocument("/tmp/curve-fixture.json", result.text)), []);
  }
  assert.throws(() => setCurveText(document(), {
    kind: "set_curve", animation: "swing", bone: "arm", timelineType: "rotate", time: 0,
    mode: "ease_in", controls: [0.25, 0, 0.75, 1],
  }), { code: "INVALID_CURVE_CONTROLS" });
});

test("curve mode switches and rejects missing or conflicting segments", () => {
  const stepped = setCurveText(document(), {
    kind: "set_curve", animation: "swing", bone: "arm", timelineType: "rotate", time: 0, mode: "stepped",
  });
  assert.equal(JSON.parse(stepped.text).animations.swing.bones.arm.rotate[0].curve, "stepped");
  const linear = setCurveText(parseDocument("/tmp/curve-fixture.json", stepped.text), {
    kind: "set_curve", animation: "swing", bone: "arm", timelineType: "rotate", time: 0, mode: "linear",
  });
  assert.equal(Object.hasOwn(JSON.parse(linear.text).animations.swing.bones.arm.rotate[0], "curve"), false);
  assert.throws(() => setCurveText(document(), {
    kind: "set_curve", animation: "swing", bone: "arm", timelineType: "rotate", time: 1, mode: "stepped",
  }), { code: "NO_NEXT_KEY" });
  assert.throws(() => setCurveText(document(), {
    kind: "set_curve", animation: "swing", bone: "arm", timelineType: "rotate", time: 0,
    mode: "bezier", controls: [0.8, 0, 0.2, 1],
  }), { code: "INVALID_CURVE_CONTROLS" });
});
