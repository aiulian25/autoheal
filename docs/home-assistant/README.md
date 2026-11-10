# Autoheal and Home Assistant's assistant

Autoheal tells Home Assistant what stays a problem, and asks before it updates a container: Home Assistant says it aloud or shows it on a phone, and a person answers yes or no. Home Assistant writes each answer as one line into a Text helper, and Autoheal reads it on the connection it already keeps to Home Assistant. Home Assistant never has to reach Autoheal: no key, no certificate and no address of Autoheal's goes into Home Assistant.

Autoheal asks only once a test question from its card was answered, and asking is ticked there; until then, every message is told, and nobody is asked.

Autoheal decides what is true and what is allowed. Home Assistant decides when and where to say it. A yes is a button, or words matched by Home Assistant's own sentence matching: no model takes part in an answer, and the assistant works the same with any conversation agent, or none.

## With the blueprint

Autoheal's assistant card, in **Settings → Connections**, has these three steps, each with its button at the address Autoheal already has for Home Assistant:

1. **Make the answer box**: a Text helper of its own for the answers (**Settings → Devices & services → Helpers → Create helper → Text**). Any name.
2. **Add the automation**: import the blueprint, by the card's button or this one:

   [![Open your Home Assistant instance and show the blueprint import dialog.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Faiulian25%2Fautoheal%2Fblob%2Fmain%2Fdocs%2Fhome-assistant%2Fautoheal-assistant.yaml)

   or by its link: `https://github.com/aiulian25/autoheal/blob/main/docs/home-assistant/autoheal-assistant.yaml`. Then make an automation from it. Its form asks for:

   - **Webhook ID**: the one the card shows in this step, with Copy. Treat it as a password.
   - **Answer box**: the Text helper from step 1.
   - **Voice satellite** and **Phone**: either, both or neither. With neither, Home Assistant's own notifications show each message.
   - **Quiet from** and **Quiet until** (22:00 to 08:00), and **Aloud only when someone is home**: when nothing is said aloud. A phone still gets it.
   - **Words for yes** and **Words for no**, the two **phone buttons**, and what is **said after an answer** ("One moment."). Another language is a matter of typing other words here.

3. **Send a test question** from the card, and answer it, aloud or on the phone. The card says how it was answered, or which part did not come back. Once it is answered, tick what Autoheal may ask about.

What the blueprint does with each message:

- A message is said aloud on the satellite when it is not quiet hours, someone is home (if that is asked) and the satellite is free; otherwise it goes to the phone; with neither, it shows in Home Assistant. Then it writes `heard`.
- A question is asked on the satellite, and the words heard are matched against the words for yes and for no. If nobody answers, or the satellite cannot ask, the phone gets the question with its two buttons. A button writes its answer whenever it is pressed, for as long as the question is open.
- A message that cannot be said or shown now (quiet hours, nobody home, the satellite busy, and no phone) writes `later`, and Autoheal sends it again an hour later. A reply is never put off: it answers someone now, so it is shown in Home Assistant instead.

## The contract, for your own automations

### What Autoheal sends

Autoheal posts JSON to the webhook `/api/webhook/<webhook ID>`:

```json
{
  "id": "0b6c1d2e-5f00-4c4b-9a6e-2d8e7f3a1b90",
  "kind": "container_updates",
  "tier": "ask",
  "host": "nas1",
  "names": ["whoami", "gitea"],
  "say": "Two updates are waiting on nas one: whoami and gitea. Shall I update them?",
  "text": "nas1: 2 updates are waiting: whoami, gitea. Update them?",
  "code": "Zk3vQ8mN2pL5tR7wX9yB1c"
}
```

| Field           | Meaning                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | Names this message. Goes back with `heard` or `later`.                                                                                                                                       |
| `kind`          | `host_silent`, `disk`, `drive`, `container`, `recovery_held`, `container_updates`, `newer_version`, `host_updates`, `reboot`, or `test`.                                                     |
| `tier`          | `urgent` and `say` are told. `ask` is a question. `reply` is Autoheal's word back on an answer. An automation that does not know a tier treats it as `say`: it is said, and nobody is asked. |
| `say`, `text`   | Ready to say aloud, names spelled as they are said and with the form of address set in Autoheal, if any; ready to write on a phone.                                                          |
| `host`, `names` | The plain facts, for an automation that words the message itself.                                                                                                                            |
| `code`          | Only with `ask`. Names the question, and stays the same each time it is asked, until an answer uses it. Goes back with `yes` or `no`.                                                        |
| `from`, `to`    | Only with `newer_version`: the tag the container runs, and the tag a yes moves it to.                                                                                                        |
| `nonce`         | Only with `test`, and the same as its `id`. The card's test question is a `test` with `tier` `ask` and a `code`: it is answered as any question is.                                          |

A question names three updates at most, and a yes covers exactly those. A newer version is asked about on its own.

### What Autoheal reads back

One line, set on any Text helper (`input_text.set_value`):

```
autoheal heard <id> <time>
autoheal later <id> <time>
autoheal yes <code> <time> voice Living Room
autoheal no <code> <time> phone
```

- `<time>` is when the line is written, in seconds: `{{ now().timestamp() | int }}`.
- `<id>` and `<code>` go back exactly as they came: letters, digits, `_` and `-`. An id is at most 36 characters, a code 22.
- After the time: `voice` or `phone`, and, if known, the room: up to 30 letters, digits, spaces and `.` `'` `-`. Both are kept in Autoheal's audit log, and trusted for nothing.
- The whole line is at most 100 characters, the size of a Text helper unless made longer.
- Anything else is ignored, without a word: other text, other helpers, other entities.

| Line    | Written when                                                                                                       | What Autoheal does                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heard` | The message was said or shown.                                                                                     | A message is marked as heard. A question counts as asked once; one with no answer is asked again a day later, three times at most.                                          |
| `later` | It was not the time: quiet hours, nobody home, the satellite busy. Never for a `reply`, which answers someone now. | Nothing counts. The message is sent again an hour later; a reply is not sent again.                                                                                         |
| `yes`   | The person said yes, or pressed the yes button.                                                                    | Checks the question still holds, then hands the updates over, or changes the tag, as the dashboard's own hand-over does, and says so. Says what came of it once it is done. |
| `no`    | The person said no, or pressed the no button.                                                                      | Remembers it: not asked again until a newer image, or a later version, is out. A newer version is ignored, as **Ignore this version** on the dashboard does.                |

The rules:

- Each line counts once. A line no later than the last one counted for its message is ignored, so the line a restarted Home Assistant restores changes nothing. That is also why each line carries its time: Home Assistant tells nobody when a helper is set to the text it already holds.
- A code is good for one answer. A yes that cannot be carried out now (the host is not answering, say) is answered with why, and the question is asked again later with a new code.
- An answer to a question that is no longer open is answered with that; one already answered is ignored.
- At most 30 lines a minute are read.
- `heard` can also come by Home Assistant's `rest_command` with the key from Autoheal's card, as before.

## Who can answer

Anyone who can set a helper in that Home Assistant, or speak in the room. A line counts only with the code of an open question, and that code is only in the message Autoheal sent and on the phone's buttons. Autoheal acts on a yes as the admin who connected the assistant, and only while they are an admin. Autoheal reads Home Assistant with a user that need not be an admin, and never writes to it. The blueprint's webhook takes calls from the local network only.
