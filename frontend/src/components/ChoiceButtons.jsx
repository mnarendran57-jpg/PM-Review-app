import { useState } from 'react';

// A small set of mutually exclusive choices, shown as buttons rather than a dropdown.
//
// WHY THIS EXISTS
//
// A PM reported that the "Not yet" option on the submittal form "is not clickable". It was: it is
// the default, so it was already selected, and clicking it changed nothing on screen. A control
// that cannot acknowledge a click looks broken even when it is behaving perfectly — and the person
// then has no way to tell "already chosen" from "my click did not register", so they click again,
// and conclude the form is faulty.
//
// Three things are needed, and the copies this replaces had none of them:
//
//   1. A selected option that is unmistakably selected, by more than colour alone. A tick mark
//      reads as "chosen" to anyone, including someone who cannot distinguish the blue from the
//      grey — about one man in twelve.
//   2. A response to being hovered, so the buttons advertise that they are buttons at all.
//   3. A response to being PRESSED, which is the actual complaint. The button dips under the
//      pointer whether or not the click changes anything, so the click is always acknowledged.
//
// It existed three times — twice in RfiLog.jsx and once in SubmittalLog.jsx — with three slightly
// different blues and the same flaw in each. One component now, for the same reason lib/docTypes.js
// gives for collecting the document types: copies kept in step by hand do not stay in step.

export default function ChoiceButtons({ value, onChange, options, name }) {
  // Which button the pointer is currently holding down. Kept here rather than done with :active in
  // CSS because these styles are inline — and it is the press, not the hover, that answers the
  // complaint this component was written for.
  const [pressed, setPressed] = useState(null);
  const [hovered, setHovered] = useState(null);

  return (
    <div className="flex gap-2" role="group" aria-label={name}>
      {options.map(({ value: optionValue, label }) => {
        const selected = value === optionValue;
        const isPressed = pressed === optionValue;
        const isHovered = hovered === optionValue;

        return (
          <button
            key={optionValue}
            type="button"
            // Announces the state to a screen reader, which colour alone does not. Without it the
            // control is read out as two ordinary buttons and nothing says which one is in force.
            aria-pressed={selected}
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold inline-flex items-center
              gap-1.5 select-none"
            style={{
              // Transform is in the transition list so the press is animated rather than snapping.
              transition: 'background-color 120ms, color 120ms, border-color 120ms, transform 80ms',
              transform: isPressed ? 'scale(0.96)' : 'scale(1)',
              // A border on both states, transparent on the selected one, so the two buttons are
              // the same size and the row does not shift by a pixel as the choice changes.
              //
              // Written out as three longhand properties rather than the `border` shorthand: React
              // warns when a shorthand and one of its longhands are both set on the same element,
              // and resolves it by DROPPING the longhand on re-render — so the hover border colour
              // would apply on first paint and then silently vanish.
              borderWidth: 1,
              borderStyle: 'solid',
              ...(selected
                ? {
                  background: isHovered || isPressed ? '#1e40af' : '#1d4ed8',
                  color: '#fff',
                  borderColor: 'transparent',
                }
                : {
                  background: isHovered || isPressed ? '#f3f6fa' : '#fff',
                  color: isHovered ? '#374151' : '#6b7280',
                  borderColor: isHovered ? '#cbd5e1' : '#e8edf2',
                }),
            }}
            onMouseEnter={() => setHovered(optionValue)}
            onMouseLeave={() => { setHovered(null); setPressed(null); }}
            onMouseDown={() => setPressed(optionValue)}
            onMouseUp={() => setPressed(null)}
            // A keyboard press should look like a press too, or the control is only honest to a
            // mouse. Space and Enter both activate a button.
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') setPressed(optionValue); }}
            onKeyUp={() => setPressed(null)}
            onBlur={() => setPressed(null)}
            onClick={() => onChange(optionValue)}
          >
            {/* The tick is what says "this one", independently of colour. The space it occupies is
                held open on the unselected button as well, so choosing does not make the row jump. */}
            <span aria-hidden="true" style={{
              width: 10, display: 'inline-block', opacity: selected ? 1 : 0,
              transition: 'opacity 120ms',
            }}>✓</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
