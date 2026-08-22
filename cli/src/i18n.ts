// One language for every human-facing line, chosen once and remembered.
// `rcq lang ru` writes the choice into the state dir (same 0600 discipline as
// the rest of the state); unset, the environment decides: a ru* locale in
// LC_ALL/LC_MESSAGES/LANG answers Russian, anything else answers English.
//
// The table is deliberately dumb: every string lives here ONCE with both
// languages side by side, greppable by key or by any fragment of the text.
// No library, no plural rules, no nesting. DATA stays out of the table: uin
// numbers, history lines, contact rows, whoami VALUES, message bodies and
// the <photo ...> descriptors never pass through tr(), so pipes and scripts
// read the same bytes in any language.

import fs from 'node:fs'
import { statePath, writeFileAtomic } from './state'

export type Lang = 'en' | 'ru'

const LANG_FILE = 'lang'

let _lang: Lang | null = null

function envLang(): Lang {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  return /^ru/i.test(raw) ? 'ru' : 'en'
}

export function currentLang(): Lang {
  if (_lang) return _lang
  try {
    const saved = fs.readFileSync(statePath(LANG_FILE), 'utf8').trim()
    if (saved === 'en' || saved === 'ru') return (_lang = saved)
  } catch {
    /* never chosen - the environment decides */
  }
  return (_lang = envLang())
}

export function setLang(lang: Lang): void {
  writeFileAtomic(statePath(LANG_FILE), lang + '\n')
  _lang = lang
}

const T = {
  usage: {
    en: `rcq - RCQ console client v{version}

start here:
  rcq                                         the conversation: live incoming + a prompt that sends
  rcq register [--nick NAME] [--island URL]   create an account, print UIN + recovery phrase
  rcq restore "<24 words>" [--island URL]     restore an account from its phrase

for scripts and one-shots (stdout is data, status goes to stderr):
  rcq whoami                                  print uin, nickname, island, device id
  rcq nick "NAME"                             rename this account
  rcq contacts                                list contacts (uin, nickname, status)
  rcq who <uin>                               who is this number: name, and whether you know them
  rcq find "NAME"                             search the island for people by name
  rcq add <uin>                               send a contact request
  rcq requests                                incoming and outgoing contact requests
  rcq accept <uin> | rcq decline <uin>        answer an incoming request
  rcq cancel <uin>                            withdraw a request you sent
  rcq block <uin> | rcq unblock <uin>         stop / resume hearing from someone
  rcq remove <uin> [--yes]                    drop a contact on both sides
  rcq groups                                  list your rooms (id, name, members, rules)
  rcq join <id>                               join an open group
  rcq log [<uin>|g<id>] [n]                   last n lines of a thread from the history file
  rcq send <uin>|g<id> "text" [--yes]         one-shot: drain, send, wait for the receipt, exit
                                              (--yes agrees to write to a non-contact)
  rcq watch                                   read-only stream of incoming messages
  rcq export                                  print the history file path and line count
  rcq lang [en|ru]                            show or set the language
  rcq --version                               version + update check
  rcq --help                                  this text

state lives in $RCQ_CLI_HOME (default ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 shows protocol detail; NO_COLOR strips colour.
`,
    ru: `rcq - консольный клиент RCQ v{version}

начните отсюда:
  rcq                                         разговор: живые входящие + строка, которая отправляет
  rcq register [--nick ИМЯ] [--island URL]    создать аккаунт, напечатать UIN и фразу восстановления
  rcq restore "<24 слова>" [--island URL]     восстановить аккаунт по фразе

для скриптов и разовых команд (stdout это данные, статус идёт в stderr):
  rcq whoami                                  напечатать uin, ник, остров, id устройства
  rcq nick "ИМЯ"                              переименовать аккаунт
  rcq contacts                                список контактов (uin, ник, статус)
  rcq who <uin>                               чей это номер: имя и знакомы ли вы
  rcq find "ИМЯ"                              искать людей на острове по имени
  rcq add <uin>                               отправить заявку в контакты
  rcq requests                                входящие и исходящие заявки
  rcq accept <uin> | rcq decline <uin>        ответить на входящую заявку
  rcq cancel <uin>                            отозвать свою заявку
  rcq block <uin> | rcq unblock <uin>         перестать / снова получать сообщения
  rcq remove <uin> [--yes]                    удалить контакт у обоих
  rcq groups                                  список ваших комнат (id, имя, участники, правила)
  rcq join <id>                               вступить в открытую группу
  rcq log [<uin>|g<id>] [n]                   последние n строк переписки из файла истории
  rcq send <uin>|g<id> "текст" [--yes]        разово: забрать очередь, отправить, дождаться квитанции, выйти
                                              (--yes соглашается писать не-контакту)
  rcq watch                                   поток входящих, только чтение
  rcq export                                  напечатать путь к файлу истории и число строк
  rcq lang [en|ru]                            показать или сменить язык
  rcq --version                               версия + проверка обновления
  rcq --help                                  этот текст

состояние живёт в $RCQ_CLI_HOME (по умолчанию ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 показывает детали протокола; NO_COLOR убирает цвет.
`,
  },

  'lang.usage': {
    en: 'usage: rcq lang [en|ru]  (unset, the language follows LANG/LC_ALL)',
    ru: 'использование: rcq lang [en|ru]  (без выбора язык берётся из LANG/LC_ALL)',
  },
  'lang.invalid': {
    en: "lang takes 'en' or 'ru', not '{arg}'",
    ru: "lang принимает 'en' или 'ru', а не '{arg}'",
  },
  'lang.set': { en: 'language: {lang}', ru: 'язык: {lang}' },

  'args.flagNeedsValue': { en: '{flag} needs a value', ru: '{flag} требует значение' },
  'args.noCommand': { en: 'no command', ru: 'нет команды' },
  'args.unknownCmd': { en: "unknown command '{cmd}'", ru: "неизвестная команда '{cmd}'" },

  'err.noAccount': {
    en: "no account here - run 'rcq register' or 'rcq restore' first",
    ru: "здесь нет аккаунта, сначала 'rcq register' или 'rcq restore'",
  },
  'err.accountExists': {
    en: "an account already lives here - 'rcq whoami'. Use RCQ_CLI_HOME for a second one",
    ru: "аккаунт здесь уже есть, см. 'rcq whoami'. Второй заводится через RCQ_CLI_HOME",
  },
  'err.sessionRefused': {
    en: 'the island refused this session (revoked or account gone)',
    ru: 'остров отверг эту сессию (отозвана или аккаунт удалён)',
  },
  'err.mintFailed': {
    en: 'could not mint a session token (island unreachable?)',
    ru: 'не удалось получить токен сессии (остров недоступен?)',
  },
  'err.sessionRejected': {
    en: 'the island rejected this session (unlinked or revoked)',
    ru: 'остров отклонил эту сессию (отвязана или отозвана)',
  },

  'label.phrase': { en: 'phrase', ru: 'фраза' },
  'label.nickname': { en: 'nickname', ru: 'ник' },
  'label.island': { en: 'island', ru: 'остров' },
  'label.device': { en: 'device', ru: 'устройство' },

  'phrase.keep': {
    en:
      '\nKEEP THIS PHRASE. It recreates the account on any device, forever.\n' +
      'Anyone who has it IS this account. It is stored in the state dir:\n' +
      'delete it there after writing it down if this box is not trusted.\n',
    ru:
      '\nСОХРАНИТЕ ЭТУ ФРАЗУ. Она навсегда восстанавливает аккаунт на любом устройстве.\n' +
      'Кто знает фразу, тот и есть этот аккаунт. Копия лежит в каталоге состояния:\n' +
      'запишите фразу и удалите копию, если этой машине нет полного доверия.\n',
  },

  'restore.needsPhrase': {
    en: 'restore needs the quoted 24-word phrase',
    ru: 'restore ждёт фразу из 24 слов в кавычках',
  },
  'restore.done': {
    en: 'restored. The libsignal device registers on the first send/watch.',
    ru: 'восстановлено. Устройство libsignal зарегистрируется при первом send или watch.',
  },

  'nick.needsName': { en: 'nick needs the new name in quotes', ru: 'nick ждёт новое имя в кавычках' },
  'nick.done': { en: 'you are now "{name}"', ru: 'теперь вы "{name}"' },

  'add.needsUin': { en: 'add needs a numeric UIN', ru: 'add ждёт числовой UIN' },
  'add.sent': { en: 'contact request sent to {who}', ru: 'заявка в контакты отправлена {who}' },
  // The island auto-accepts when they had already asked for us. Saying "sent"
  // there hid the one case where adding simply worked.
  'add.mutual': {
    en: '{who} had already asked for you, so you are contacts now',
    ru: '{who} уже отправлял вам заявку, теперь вы контакты',
  },
  'add.already': { en: '{who} is already in your contacts', ru: '{who} уже в ваших контактах' },

  // Contact requests: the half the console could never answer.
  'req.none': { en: 'no contact requests', ru: 'заявок в контакты нет' },
  'req.noneFrom': { en: 'there is no request from {who}', ru: 'от {who} нет заявки' },
  'req.waiting': {
    en: '{n} contact request(s) waiting - see "rcq requests"',
    ru: 'ждут ответа заявок: {n}, показать: "rcq requests"',
  },
  'req.answerHint': { en: 'wants to add you: /accept {uin} or /decline {uin}', ru: 'хочет добавить вас: /accept {uin} или /decline {uin}' },
  'req.statePending': { en: 'waiting for their answer', ru: 'ждём их ответа' },
  'req.stateDeclined': { en: 'declined', ru: 'отклонено' },
  'req.incoming': { en: '{who} wants to add you: /accept {uin} or /decline {uin}', ru: '{who} хочет добавить вас: /accept {uin} или /decline {uin}' },
  'req.accepted': { en: '{who} accepted your contact request', ru: '{who} принял вашу заявку' },
  'req.declined': { en: '{who} declined your contact request', ru: '{who} отклонил вашу заявку' },
  'req.withdrawn': { en: '{who} withdrew their contact request', ru: '{who} отозвал свою заявку' },
  'req.youAccepted': { en: '{who} is now in your contacts', ru: '{who} теперь в ваших контактах' },
  'req.youDeclined': { en: 'declined the request from {who}', ru: 'заявка от {who} отклонена' },
  'req.cancelled': { en: 'your request to {who} is withdrawn', ru: 'ваша заявка к {who} отозвана' },
  'accept.needsUin': { en: 'accept needs a numeric UIN', ru: 'accept ждёт числовой UIN' },
  'decline.needsUin': { en: 'decline needs a numeric UIN', ru: 'decline ждёт числовой UIN' },
  'cancel.needsUin': { en: 'cancel needs a numeric UIN', ru: 'cancel ждёт числовой UIN' },

  'find.needsQuery': { en: 'find needs a name in quotes', ru: 'find ждёт имя в кавычках' },
  'find.none': { en: 'nobody on this island matches "{q}"', ru: 'на этом острове никто не подходит под "{q}"' },

  'block.needsUin': { en: 'block needs a numeric UIN', ru: 'block ждёт числовой UIN' },
  'block.done': { en: '{who} is blocked', ru: '{who} заблокирован' },
  'block.undone': { en: '{who} is unblocked', ru: '{who} разблокирован' },
  'remove.needsUin': { en: 'remove needs a numeric UIN', ru: 'remove ждёт числовой UIN' },
  'remove.confirm': {
    en: 'remove {who} from your contacts, on both sides? [y/N] ',
    ru: 'удалить {who} из контактов у обоих? [y/N] ',
  },
  'remove.needsYes': {
    en: 'not removed: {who} would go from both contact lists. Add --yes to do it',
    ru: 'не удалено: {who} исчезнет из списков у обоих. Добавьте --yes, чтобы удалить',
  },
  'remove.cancelled': { en: 'nothing removed', ru: 'ничего не удалено' },
  'remove.done': { en: '{who} is no longer in your contacts', ru: '{who} больше не в ваших контактах' },

  // Names, and how much of a stranger somebody is. The label itself ("Ivan
  // (#396)") is DATA and never passes through here; these are the words around
  // it.
  'dir.stale': {
    en: 'names may be out of date, the roster did not load: {err}',
    ru: 'имена могут быть устаревшими, список не загрузился: {err}',
  },

  'who.needsUin': { en: 'who needs a numeric UIN', ru: 'who ждёт числовой UIN' },
  'who.contact': { en: 'in your contacts', ru: 'в ваших контактах' },
  'who.stranger': { en: 'not in your contacts', ru: 'не в ваших контактах' },
  'who.thread': { en: 'you have exchanged messages before', ru: 'вы уже переписывались' },
  'who.noThread': { en: 'you have never exchanged a message', ru: 'вы ещё ни разу не переписывались' },
  'who.unreachable': {
    en: 'could not ask the island who #{uin} is',
    ru: 'не удалось спросить остров, кто такой #{uin}',
  },

  // The gate on the FIRST message of a thread. The mailbox stays open (anyone
  // may write first); what ends here is doing it by accident.
  'stranger.cold': {
    en: '{who} is not in your contacts, and you have never written to them',
    ru: '{who} не в ваших контактах, и вы им ещё не писали',
  },
  'stranger.missing': {
    en: 'there is no account #{uin} on this island (a typo?)',
    ru: 'на этом острове нет аккаунта #{uin} (опечатка?)',
  },
  'stranger.unverified': {
    en: 'and the island did not answer who they are',
    ru: 'и остров не ответил, кто это',
  },
  'stranger.reveals': {
    en: 'a message tells them this account exists',
    ru: 'сообщение скажет им, что этот аккаунт существует',
  },
  'stranger.confirm': { en: 'send to {who} anyway? [y/N] ', ru: 'всё равно отправить {who}? [y/N] ' },
  'stranger.cancelled': { en: 'not sent', ru: 'не отправлено' },
  'stranger.needsYes': {
    en: 'not sent: {who} is not in your contacts. Add --yes to send anyway',
    ru: 'не отправлено: {who} не в ваших контактах. Добавьте --yes, чтобы всё равно отправить',
  },
  'stranger.willAsk': {
    en: 'nothing is sent yet: the first message asks first',
    ru: 'пока ничего не отправлено: перед первым сообщением спросим',
  },
  'inbound.stranger': { en: '{who} is not in your contacts', ru: '{who} не в ваших контактах' },

  // Things that used to fail without a word.
  'fail.carbon': {
    en: 'this message will not appear on your other devices: {err}',
    ru: 'это сообщение не появится на других ваших устройствах: {err}',
  },
  'fail.receipt': {
    en: 'delivery receipts are not going out, the sender keeps one tick',
    ru: 'квитанции о доставке не уходят, у отправителя останется одна галочка',
  },
  // The transport, in words. See errors.ts: these replace Node's raw
  // `fetch failed` wherever a failure reaches a person.
  'net.unreachable': { en: 'the island did not answer', ru: 'остров не ответил' },
  'net.timeout': { en: 'the island did not answer in time', ru: 'остров не ответил вовремя' },
  'net.noHost': { en: 'no such island (the address did not resolve)', ru: 'такого острова нет (адрес не разрешился)' },

  'fail.live': {
    en: 'a live message could not be opened ({err}); the next queue read retries it',
    ru: 'живое сообщение не удалось открыть ({err}); повтор при следующем чтении очереди',
  },
  'fail.contacts': {
    en: 'showing the last known list, the island did not answer: {err}',
    ru: 'показан последний известный список, остров не ответил: {err}',
  },
  'fail.command': { en: '{cmd} failed: {err}', ru: '{cmd} не выполнено: {err}' },

  'send.needsArgs': { en: 'send needs <uin> and "text"', ru: 'send ждёт <uin> и "текст"' },
  'send.failed': { en: 'send failed: {err}', ru: 'отправка не удалась: {err}' },
  'send.kept': { en: 'not sent, your text: {text}', ru: 'не отправлено, ваш текст: {text}' },
  // A line typed while the one before it is still on the wire. Sends are
  // strictly one at a time, so without this the text simply vanished off the
  // input row and nothing appeared until the one ahead of it finished.
  'send.queued': { en: '… waiting for the line before it: {text}', ru: '… ждёт предыдущую строку: {text}' },
  // The interactive loop echoes the line before it sends it, so the text is
  // already on screen: what this adds is that it did NOT go, and that it is
  // still here.
  'send.failedTo': { en: '✗ not sent to {who}: {err}', ru: '✗ не отправлено {who}: {err}' },
  'send.retryHint': { en: '  the text is kept - /retry sends it again', ru: '  текст сохранён, повторить: /retry' },
  'retry.nothing': { en: 'nothing to retry', ru: 'повторять нечего' },
  'send.tip': {
    en: "tip: plain 'rcq' is the live conversation - incoming above, a prompt below",
    ru: "подсказка: просто 'rcq' открывает живой разговор, входящие сверху, строка ввода снизу",
  },
  'word.delivered': { en: 'delivered', ru: 'доставлено' },
  'word.sent': { en: 'sent', ru: 'отправлено' },

  'provision.v1only': {
    en: 'provision failed ({err}) - v=1 only',
    ru: 'устройство не зарегистрировалось ({err}), только v=1',
  },
  'provision.v1receive': {
    en: 'provision failed ({err}) - v=1 receive only',
    ru: 'устройство не зарегистрировалось ({err}), приём только v=1',
  },

  // The connection, said once each way. The close codes are RCQ_VERBOSE: two
  // raw [ws] lines per redial used to run through the middle of a conversation
  // for as long as the network was flapping.
  'ws.down': {
    en: 'offline - reconnecting, and the queue is read every 30s meanwhile',
    ru: 'нет связи, переподключаемся; очередь читается каждые 30с',
  },
  'ws.up': { en: 'back online', ru: 'связь восстановлена' },

  'watch.hello': { en: 'watching as #{uin} (Ctrl+C to stop)', ru: 'слушаем как #{uin} (Ctrl+C, чтобы выйти)' },
  'watch.readonly': {
    en: "(read-only - plain 'rcq' opens the conversation mode)",
    ru: "(только чтение, разговор открывает просто 'rcq')",
  },
  'watch.readonlyTyped': {
    en: "watch is read-only - Ctrl+C, then plain 'rcq' to talk",
    ru: "watch только читает: Ctrl+C, затем просто 'rcq', чтобы говорить",
  },
  bye: { en: 'bye', ru: 'пока' },

  'drain.noDevice': {
    en: 'drain skipped: this install has no device id yet',
    ru: 'очередь пропущена: у этой установки ещё нет id устройства',
  },
  'drain.http': { en: 'drain failed: HTTP {status}', ru: 'очередь не забрана: HTTP {status}' },
  'drain.error': { en: 'drain failed: {err}', ru: 'очередь не забрана: {err}' },
  'drain.row': {
    en: 'queued message {id} could not be read ({err}); the island will send it again',
    ru: 'сообщение {id} из очереди не прочиталось ({err}); остров пришлёт его снова',
  },
  'drain.ackFailed': {
    en: 'the island was not told the queue was read: {err}',
    ru: 'острову не удалось сообщить, что очередь прочитана: {err}',
  },

  // Rooms. One is OPEN and prints; the rest keep a count and say so once a
  // minute, because thirty rooms on one screen is not a conversation.
  'group.label': { en: 'group {gid}', ru: 'группа {gid}' },
  'group.unread': { en: '+{n} new, {how}', ru: 'новых: {n}, {how}' },
  'group.readInteractive': { en: '/g {gid} to read', ru: 'читать: /g {gid}' },
  'group.readOneShot': { en: 'rcq log g{gid} to read', ru: 'читать: rcq log g{gid}' },
  'group.unknown': { en: 'no room called "{what}" - /g lists them', ru: 'комнаты "{what}" нет, список по /g' },
  'group.notMember': {
    en: 'you are not in a group with id {gid} - "rcq groups" lists yours',
    ru: 'вы не состоите в группе с id {gid}, ваши покажет "rcq groups"',
  },
  'group.members': { en: '{n} members', ru: 'участников: {n}' },
  'group.youOwn': { en: 'yours', ru: 'ваша' },
  'group.ruleOwnerOnly': { en: 'owner posts only', ru: 'пишет только владелец' },
  'group.ruleSlowmode': { en: 'slow mode {sec}s', ru: 'медленный режим {sec}с' },
  'group.ruleNoLinks': { en: 'no links', ru: 'без ссылок' },
  'group.ownerOnly': {
    en: 'this room is read-only: only its owner posts',
    ru: 'эта комната только для чтения: пишет только владелец',
  },
  'group.noLinks': { en: 'links are not allowed in this room', ru: 'в этой комнате нельзя ссылки' },
  'group.slowmode': { en: 'slow mode: wait a little before the next message', ru: 'медленный режим: подождите перед следующим сообщением' },
  'group.slowmodeWait': { en: 'slow mode: {sec}s to go', ru: 'медленный режим: осталось {sec}с' },
  'group.gone': { en: 'this room is gone, or you are no longer in it', ru: 'этой комнаты нет, или вас в ней больше нет' },
  'group.rosterFailed': {
    en: 'nothing sent: who is in "{name}" could not be read, and a message has to be sealed to each of them ({err})',
    ru: 'ничего не отправлено: не удалось узнать, кто в "{name}", а сообщение шифруется каждому из них ({err})',
  },
  'group.noRecipients': {
    en: 'nobody in this room could be sealed to',
    ru: 'в этой комнате некому зашифровать сообщение',
  },

  'join.needsId': { en: 'join needs a group id', ru: 'join ждёт id группы' },
  'join.noSuchGroup': { en: 'there is no group {gid} on this island', ru: 'на этом острове нет группы {gid}' },
  'join.closed': { en: '"{name}" is closed - somebody in it has to add you', ru: '"{name}" закрыта, вас должен добавить кто-то из участников' },
  'join.failed': { en: 'could not join: {err}', ru: 'не удалось вступить: {err}' },
  'join.done': { en: 'you are in "{name}"', ru: 'вы в "{name}"' },

  'log.empty': { en: 'nothing in the history file for this', ru: 'в файле истории по этому ничего нет' },
  'log.badThread': {
    en: "'{what}' is neither a UIN nor a group (g21)",
    ru: "'{what}' это ни UIN, ни группа (g21)",
  },

  // ⚠ This text is the only map of the loop anybody gets, so it lists every
  // verb the loop has and nothing it does not. Sections because a flat block of
  // twenty commands is a wall; the same order as the work: talk, then people,
  // then the account.
  'interactive.help': {
    en: `talking
  /to <uin>        talk to this person (a non-contact is confirmed once, before the first message)
  /g [id|name]     open a room, or list them; its messages then print here
  /recent [n]      your latest conversations, newest first
  /log [n]         the last n lines of wherever you are (default 20)
  /retry           send the last message the network refused, again
people
  /who <uin>       who is this number: name, and whether you know them
  /find NAME       search the island for people by name
  /contacts        list contacts
  /add <uin>       send a contact request
  /requests        contact requests, both directions
  /accept <uin>    let them in     /decline <uin>   turn them down
  /cancel <uin>    withdraw a request you sent
  /block <uin>     stop hearing from them   /unblock <uin>
  /remove <uin>    drop a contact on both sides
this account
  /whoami          uin, nickname, island, device
  /nick NAME       rename this account
  /join <id>       join an open room and walk into it
  /export          where the history file is
  /lang [en|ru]    show or set the language
  /help            this text
  /quit            leave (Ctrl+D, or Ctrl+C on an empty line)
Anything else you type goes to whoever the prompt names. Up-arrow walks back
through the commands you have typed; Ctrl+C on a half-typed line drops the line
and keeps the session.`,
    ru: `разговор
  /to <uin>        говорить с этим человеком (не-контакт подтверждается один раз, перед первым сообщением)
  /g [id|имя]      открыть комнату или показать список; её сообщения начнут печататься здесь
  /recent [n]      последние разговоры, свежие сверху
  /log [n]         последние n строк там, где вы сейчас (по умолчанию 20)
  /retry           отправить заново то, что сеть не приняла
люди
  /who <uin>       чей это номер: имя и знакомы ли вы
  /find ИМЯ        искать людей на острове по имени
  /contacts        список контактов
  /add <uin>       отправить заявку в контакты
  /requests        заявки в контакты, в обе стороны
  /accept <uin>    принять       /decline <uin>   отклонить
  /cancel <uin>    отозвать свою заявку
  /block <uin>     перестать получать от них   /unblock <uin>
  /remove <uin>    удалить контакт у обоих
этот аккаунт
  /whoami          uin, ник, остров, устройство
  /nick ИМЯ        переименовать аккаунт
  /join <id>       вступить в открытую комнату и сразу войти в неё
  /export          где лежит файл истории
  /lang [en|ru]    показать или сменить язык
  /help            этот текст
  /quit            выйти (Ctrl+D или Ctrl+C на пустой строке)
Всё остальное уходит тому, чьё имя в строке ввода. Стрелка вверх листает
набранные команды; Ctrl+C на недописанной строке стирает строку, а не сессию.`,
  },
  'interactive.hello': { en: 'you are #{uin} - /help for commands', ru: 'вы #{uin}, команды по /help' },
  'interactive.noContacts': {
    en: "(no contacts yet - 'rcq add <uin>' sends a request)",
    ru: "(контактов пока нет, заявку отправит 'rcq add <uin>')",
  },
  'interactive.replyingTo': {
    en: '(replying to {who} - /to <uin> switches)',
    ru: '(отвечаем {who}, сменить собеседника: /to <uin>)',
  },
  // Somebody you do not know wrote first. The old loop made them the default
  // target of the next line typed, silently.
  'interactive.notPicked': {
    en: '{who} wrote to you - /to {uin} to answer them',
    ru: 'вам написал {who}, ответить: /to {uin}',
  },
  // The tick names the message as well as the peer: two lines to the same
  // person produced two identical notes, and in a busy stream neither of them
  // belonged to anything.
  'interactive.delivered': { en: '✓ delivered to {who}: {text}', ru: '✓ доставлено {who}: {text}' },
  'exit.finishing': { en: 'finishing the message that is still going out...', ru: 'дописываем сообщение, которое ещё уходит...' },
  'export.at': { en: 'history file: {file}', ru: 'файл истории: {file}' },
  'recent.none': {
    en: '(no conversations yet - /to <uin> starts one, /find NAME looks somebody up)',
    ru: '(разговоров пока нет: /to <uin> начинает, /find ИМЯ ищет человека)',
  },
  'recent.you': { en: 'you:', ru: 'вы:' },
  'interactive.usageTo': { en: 'usage: /to <uin>', ru: 'использование: /to <uin>' },
  'interactive.usageWho': { en: 'usage: /who <uin>', ru: 'использование: /who <uin>' },
  'interactive.usageNick': { en: 'usage: /nick NAME', ru: 'использование: /nick ИМЯ' },
  'interactive.usageAdd': { en: 'usage: /add <uin>', ru: 'использование: /add <uin>' },
  'interactive.usageAccept': { en: 'usage: /accept <uin>', ru: 'использование: /accept <uin>' },
  'interactive.usageDecline': { en: 'usage: /decline <uin>', ru: 'использование: /decline <uin>' },
  'interactive.usageCancel': { en: 'usage: /cancel <uin>', ru: 'использование: /cancel <uin>' },
  'interactive.usageFind': { en: 'usage: /find NAME', ru: 'использование: /find ИМЯ' },
  'interactive.usageBlock': { en: 'usage: /block <uin> (and /unblock <uin>)', ru: 'использование: /block <uin> (и /unblock <uin>)' },
  'interactive.usageRemove': { en: 'usage: /remove <uin>', ru: 'использование: /remove <uin>' },
  'interactive.noGroups': {
    en: '(no rooms yet - "rcq join <id>" joins an open one)',
    ru: '(комнат пока нет, вступить в открытую: "rcq join <id>")',
  },
  'interactive.unknownSlash': {
    en: 'unknown command {cmd} - /help lists them',
    ru: 'неизвестная команда {cmd}, список по /help',
  },
  'interactive.insideRcq': {
    en: 'you are already inside rcq - just type the message (or /to <uin> to switch)',
    ru: 'вы уже внутри rcq, просто наберите сообщение (сменить контакт: /to <uin>)',
  },
  'interactive.noActive': {
    en: 'no one to send to yet - /to <uin> picks a person, /g a room, /recent lists the threads you have',
    ru: 'пока некому писать: /to <uin> выбирает человека, /g комнату, /recent показывает начатые разговоры',
  },

  'update.available': { en: 'update: v{from} -> v{to}', ru: 'обновление: v{from} -> v{to}' },
  'update.how': {
    en: '(download rcq.tar.gz, unpack over the old install; state and account stay)',
    ru: '(скачайте rcq.tar.gz и распакуйте поверх старой установки; состояние и аккаунт сохранятся)',
  },

  'lock.busy': {
    en: 'another rcq (pid {pid}) is running against {dir} - one at a time',
    ru: 'другой rcq (pid {pid}) уже работает с {dir}, за раз только один',
  },
} satisfies Record<string, { en: string; ru: string }>

export type MsgKey = keyof typeof T

/// The one lookup: the string for the active language, with every {name}
/// placeholder replaced from vars. Unknown placeholders stay as typed, so a
/// missed variable is visible instead of silently empty.
export function tr(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = T[key][currentLang()]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}
