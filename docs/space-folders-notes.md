# Space folders and the local form of a synced note

Notes of a discussion between the user and the agent on 2026-11-26.

**State:** brainstorm. There is no plan and no code. The user takes time to think.

All facts about the code come from `upstream/main` at `ea8ad68`. The agent read the code. No test and no app was run.

## Words

- **age:** the encryption format of vrtti. An age file starts with `-----BEGIN AGE ENCRYPTED FILE-----`.
- **Local copy:** the text of a note that one device stores, in the database of the app (IndexedDB) or in a linked file.
- **Server copy:** the text of one revision that a device sends to the server.
- **Place:** where a device stores a note. It is "in the app" or "a file in a folder".
- **Form:** how a device stores the text of a note. It is "encrypted" (age text) or "plain" (readable text).
- **Space folder:** the folder that one device sets for one space.
- **Own setting:** a place or a form that the user gave to one note. A note without an own setting follows its space.
- **Locked device:** a device that does not have its private key in memory. This state exists only with the switch "Ask for a passphrase at start" on.

## 1. The question

Encryption was an optional property of a note. Then each synced note became encrypted, so that the server cannot read it. Does a synced note also have to be encrypted on the disk?

## 2. The finding

Yes. A synced note is encrypted in each place where the device stores it. A linked file `notes.md` becomes `notes.md.age`. The README says: "A synced note saved to disk always saves as `.age`."

The cause is one design decision. A note has one stored text, `record.content`. The device writes that text to the disk, and it sends the same bytes to the server. The server refuses a note text that is not age. Thus the local copy must be encrypted too.

The device has two separate paths:

- **Editor and disk.** A save encrypts, and an open decrypts. This path needs the key of the device.
- **Disk and server (sync).** The push and the pull move the encrypted text without a change. This path needs no key and does not go through the editor.

The places in the code (`app/js/model/docs.js` unless a different file is named):

| Where | Rule |
|---|---|
| `setSync` (2759), `sealForSpace` (1315) | A note that starts to sync is encrypted at once. A linked file is renamed to `.age` first. |
| `create` | A new note in a space is encrypted from the start. |
| `encodeForRecord` (1212) | Each save encrypts before the write to the disk. It reads `record.enc` only and has no branch for "synced". |
| `writeFileNow` (1582) | The file gets `record.content` without a change. |
| `pushPayload` (2831) | The push sends the stored text without a change. |
| `dirtyRecords` (2957) | A synced note without `enc` never goes to the server. |
| `sealSynced` (4224) | In each sync round, a synced note in plain text is encrypted. A synced plain file is detached from sync. |
| `adoptRemote` (3100), `createFromChange` | A pull stores the server text as the local copy. |
| `doc.decrypt` in `app/js/main.js`, row menu in `app/js/ui/sidebar.js` (540) | "Decrypt" is not available for a synced note. |
| `Sealed.Check` in `server/Vrtti.Server/Sealed.cs` (20) | The server refuses a note text that is not an armored age file. |

One record already works in a different way. The shared settings are plain JSON on the device, and `pushPayload` encrypts them on the way to the server. `applyRemoteSettings` decrypts them after a pull. This is the pattern for a plain local copy of a note.

## 3. Why the two are coupled

`architecture.md` makes the storage layer blind to the content: "Everything below the codec treats content as opaque."

The plan of the spaces work recorded the alternative and rejected it. The plan marks this as a decision of the agent, not of the user: "Rejected: encryption only on the way to the server, because then the codec needs a second place."

The rule "the server is blind" does not need the coupling. The server checks only the text that arrives.

## 4. What the local encryption protects

With "Ask for a passphrase at start" off (the default), the private key of the device is in the same database as the notes. A script cannot copy the key bytes. But each person who can start the app on that computer can read the notes. In this mode, the encrypted local copy protects mainly against a different program that reads the files of the disk.

With the switch on, the key is wrapped with the passphrase. Then the encrypted local copy protects the notes of a computer that is off or locked.

## 5. Solutions that were discussed

- **A.** Each device selects the local form of each synced note, encrypted or plain. For the plain form, the device encrypts at the push and decrypts at the pull. The server and the sync format do not change.
- **B.** The same as A, for linked files only. A note in the app stays encrypted.
- **C.** A readable mirror folder beside the encrypted notes. **The user rejected C.**

## 6. The direction of the user

Each device can set two things for each space:

- a space folder, where the notes of the space are files by default
- a default form, encrypted or plain

A note takes both from its space, and it can have an own setting for each. The defaults apply to new notes and to notes that arrive from the server. A different device can have different settings for the same space.

The example of the user: the desktop computer stores the space "Personal" in `/d/data/personal` as plain files. A phone keeps the same space in the app, encrypted.

The user also said:

- An encrypted file keeps the extension of its type: `note.md.age`, not `note.age`. The app does this today.
- A window of the type "open folder" must open a `note.md.age` file that this device can decrypt. The code path for this exists (`readFileForRecord`, `createFromFile`). It was not tried in the app.

## 7. Decisions of the user (round 1, 2026-11-26)

| Topic | Decision |
|---|---|
| Settings of a space | One setting with three values: "In the app", "Folder, plain files", "Folder, encrypted files". A note in the app stays encrypted. This is solution B. |
| A change of the default | The notes without an own setting change too. A note that moves to a different space takes the setting of that space. |
| A file from a different program | A file that a different program puts into the space folder does not become a note. |
| Trash | "Move to trash" removes the file from the folder. The text goes to the Trash of the app for 30 days. |
| Devices | The first version has the space folder in the desktop app only. |
| File names | Open. See section 9. |
| Next step | No plan now. |

## 8. Proposals of the agent (not confirmed)

The user wrote no objection to these points. That is not a confirmation.

1. The server and the sync format do not change. The settings of a device are not synced.
2. An encrypted file in the folder is `name.md.age` for the members of the space, as today. A plain file is `name.md`.
3. The work has two steps. Step 1: a synced file can stay plain, for one note ("Sync and keep the file readable", and "Decrypt" for a synced file). Step 2: the setting of a space and the space folder.
4. "Stop syncing" keeps the note in its place and form. They become its own setting.
5. When the device cannot reach the folder, the text of a note waits in the app, and the app writes the file later. The app has this state today for a write that failed (`file.unwritten`).
6. A locked device keeps an incoming note encrypted in the app until the user types the passphrase. Then it writes the plain file.
7. A conflict copy stays a note in the app, as today.
8. When a different program deletes a file in the folder, the note is not deleted on the other devices. The app shows the warning mark and offers "Write the file again" and "Move to trash".
9. The app never writes over a file that it did not make.

## 9. File names (open)

The user proposed the format `yyyy-MM-dd-HH-mm-first-line.md` and asked about notes with the same first line and about special characters.

The agent recommends the format. It solves three problems:

- Two notes with the same first line get different names in almost each case. One last rule stays necessary: the second name gets `-2`.
- An empty new note has a name at once, for example `2026-11-26-22-28.md`.
- Each file manager sorts the folder by the age of the notes.

Examples:

| First line of the note | File name |
|---|---|
| Shopping list | `2026-11-26-22-28-shopping-list.md` |
| # Nápady na dárky | `2026-11-26-22-31-nápady-na-dárky.md` |
| What is 2/3 of 9? | `2026-11-26-22-40-what-is-2-3-of-9.md` |
| (the note is empty) | `2026-11-26-22-45.md` |
| Shopping list, a second note in the same minute | `2026-11-26-22-28-shopping-list-2.md` |
| Shopping list, as an encrypted file | `2026-11-26-22-28-shopping-list.md.age` |

A proposed rule for the characters:

1. Take the title that the user typed for the note. If the note has none, take the first line.
2. Remove the Markdown marks at the start of the line.
3. Make all letters small. Keep letters with diacritics and letters of other alphabets.
4. Replace each group of other characters with one `-`.
5. Cut the result at 60 characters, at the end of a word.
6. Compare two names without a difference between small and capital letters.

`baseName` in `app/js/model/backup.js` has the list of the characters and the names that Windows refuses.

Three points need a decision:

1. **Which time is in the name?** The devices do not share the creation time of a note today. The encrypted data of a note (`sealMeta`) has the title, the first line and the language, and no time. Proposal: the app adds the creation time to that data. A note from before the change gets the time when it arrived on the device. The name uses the local time of the device.
2. **When does the first line go into the name?** A new note starts with the date and the time only. Proposal: the app renames the file one time, when the cursor leaves the first line for the first time, or when the note closes. After that, only "Rename file…" changes the name. A note from the server has its first line, so it gets the full name at once.
3. **What does the list in the app show?** Today the title of a file note is its file name (`titleOf`). Proposal: a note in a space folder shows its first line, the same as on each other device.

The app finds the file of a note by a stored link, not by its name. Thus the name is only for the user and for other programs.

## 10. Details for a later plan

- A space in the mode "Titles only" does not have the text of each note on the device. A space folder needs the text of each note.
- The user changes the path of a space folder. The app must move the files, or leave them and start a new folder.
- Two devices use the same folder, for example on a network drive.
- The user opens the space folder in a window of the type "open folder". A click on a file there must open the note of the space, also for a plain `.md` file. `bufferForHandle` makes this check. It needs a test for this case.
- The attachments work (pull request 45) needs a place for the files of a note in a space folder.

## 11. Facts about the code of today

- Only "Save to disk…" with a dialog makes a file. The one exception is "back up" (`app/js/model/backup.js`), which writes the notes of a space into a folder that the user selects.
- A note from the server is always stored in the app. Two places make such a note: `createFromChange` and the batch path in `applyRemoteBatch`.
- The title of a file note is its file name. The app never renames a file because the first line changed. The only renames add or remove `.age`, apart from "Rename file…".
- The disk layer has no function that deletes a file, makes a folder, or moves a file to a different folder (`src-tauri/src/disk.rs`).
- A file note has "Remove from list" in place of "Move to trash". The file stays on the disk, and the other devices keep the note.
- The app looks at the files of known notes when the window gets the focus, and each 30 seconds. It does not watch a folder.
- The desktop app, Chrome and Edge have disk access. Firefox, Safari and phones do not.
- In the browser, each file needs one click after a restart before the app can use it again. The desktop app needs no click.
- One setting of a device for a space exists: `sync.spaces` ("Titles only" or "Open as tabs"). A comment at `sync.newNotes` in `app/js/sync/client.js` names "a folder for new notes" as a later field.
- The app has one dark theme.

## 12. Possible defects in the code of today (not confirmed)

The agent found these while it read the code. No test confirmed them.

- A different program writes readable text into a synced `notes.md.age`. Then `takeDisk` removes `enc` from the record. In the next sync round, `sealSynced` detaches the note from sync and asks the server to purge its revisions.
- After "Stop syncing", a note in the app becomes plain text. At "Sync again", a check compares that plain text with the encrypted text of the server. The two are never equal, so the device makes a conflict copy also when the texts are the same.

## 13. Not examined

- The steps of a push on a locked device.
- In the browser, if one permission click for a folder is sufficient for all files in it.
- The pages of the discussion were not opened in a browser by the agent.
