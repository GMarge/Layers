# Layers design decisions

The single source of truth for how Layers looks and moves. Values live in
`web/src/styles/tokens.css`; change them there.

## The one job of the screen

An employee works in a normal company AI chat. Layers stays out of the way until a
prompt needs a decision, then comes to the prompt and offers one clear way forward.

## Colour

| Token | Value | Meaning |
|---|---|---|
| `--agent` | `#2b63ff` | The agent: mascot, primary action, links it offers. Nothing else is blue. |
| `--layer-pink` | `#ff1fd2` | Ambient, and the agent acting. Taken from the logo. |
| `--layer-red` | `#ff3d2e` | A held prompt. Taken from the logo. |
| `--layer-orange` | `#ff9a14` | A rule or workflow intervention. Taken from the logo. |
| `--ink` / `--surface` | `#131316` / `#ffffff` | The host workspace. Neutral on purpose. |

The host workspace is greyscale, so blue always means Layers. The three layer colours
only appear at the edge of the screen and behind the mascot.

## Type

One family, Archivo. Normal width for the workspace, 116% width for anything Layers
says. Martian Mono only for things that are literally code: rule ids, tool names.

## Shape and spacing

- 4px spacing scale.
- Nested corners follow inner radius = outer radius - padding (bubble 18, actions 12).
- Group with space, not boxes. No accent stripes, no badges above headings.

## Motion

- The mascot moves on a damped spring that can be redirected mid-flight.
- Motion reports state: the edge breathes while a prompt is held, a light travels the
  perimeter while the agent works. Nothing moves for decoration.
- `prefers-reduced-motion` and the lab's Motion switch turn all of it off.

## Copy

Plain sentences. Say what happened, then what the employee can do. No em dashes,
no emoji, no claims about time or money saved.

## Rules Layers follows

- It checks a prompt only when the employee presses Send, and says so on screen.
- It never deletes a draft. Every intervention can be undone or appealed.
- It names the rule that triggered and who set it.
- It shows each tool call it made, in plain English with the real call underneath.

## Where the agent lives

- It rests inside the chat box: the box wears its outline and only the eyes show.
  Tapping the eyes pulls it out; dragging it onto the box tucks it back in.
- It can also float. The employee drags it anywhere and it remembers the spot.
- It only ever speaks from the chat box, and the thread scrolls up to leave room,
  so a bubble never covers a message.
- The employee can ask it a question before sending anything.

## Hiding, settings and uncertainty

- Alt+L hides the agent completely and brings it back. While hidden it still checks
  prompts, and the page says so. If it has to hold a prompt it comes back by itself.
- Tapping the agent shows the last thing it said, or opens a question box.
- Settings (from the question box) let the employee pick the look and where it waits.
  The company's choices are shown there too, read-only.
- When Layers cannot tell whether a prompt fits the project it says so, shows the
  words that counted each way, and follows the company's choice: ask the employee,
  let it through and log it, or hand it to a person.
- Melting into the chat box is a liquid animation: a blob and a pool fused by an SVG
  filter, with the outline colour flowing out from where the droplet lands.
