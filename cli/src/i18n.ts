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
  rcq add <uin>                               send a contact request
  rcq send <uin> "text" [--yes]               one-shot: drain, send, wait for the receipt, exit
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
  rcq add <uin>                               отправить заявку в контакты
  rcq send <uin> "текст" [--yes]              разово: забрать очередь, отправить, дождаться квитанции, выйти
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

  'group.label': { en: 'group {gid}', ru: 'группа {gid}' },
  'group.senderKeys': {
    en: '{group}: <sender-keys broadcast - groups are not in the CLI yet>',
    ru: '{group}: <рассылка sender-keys, групп в CLI пока нет>',
  },
  'group.banked': {
    en: '+{n} (history only; groups live in the apps)',
    ru: '+{n} (только в историю; группы живут в приложениях)',
  },

  'interactive.help': {
    en: `  /to <uin>   talk to this person (a non-contact is confirmed once, before the first message)
  /who <uin>  who is this number: name, and whether you know them
  /add <uin>  send a contact request
  /nick NAME  rename this account
  /contacts   list contacts
  /help       this text
  /quit       leave (Ctrl+C and Ctrl+D work too)
anything else you type goes to the active contact.`,
    ru: `  /to <uin>   говорить с этим человеком (не-контакт подтверждается один раз, перед первым сообщением)
  /who <uin>  чей это номер: имя и знакомы ли вы
  /add <uin>  отправить заявку в контакты
  /nick ИМЯ   переименовать аккаунт
  /contacts   список контактов
  /help       этот текст
  /quit       выйти (Ctrl+C и Ctrl+D тоже работают)
всё остальное уходит активному контакту.`,
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
  'interactive.delivered': { en: '✓ delivered to {who}', ru: '✓ доставлено {who}' },
  'interactive.usageTo': { en: 'usage: /to <uin>', ru: 'использование: /to <uin>' },
  'interactive.usageWho': { en: 'usage: /who <uin>', ru: 'использование: /who <uin>' },
  'interactive.usageNick': { en: 'usage: /nick NAME', ru: 'использование: /nick ИМЯ' },
  'interactive.usageAdd': { en: 'usage: /add <uin>', ru: 'использование: /add <uin>' },
  'interactive.unknownSlash': {
    en: 'unknown command {cmd} - /help lists them',
    ru: 'неизвестная команда {cmd}, список по /help',
  },
  'interactive.insideRcq': {
    en: 'you are already inside rcq - just type the message (or /to <uin> to switch)',
    ru: 'вы уже внутри rcq, просто наберите сообщение (сменить контакт: /to <uin>)',
  },
  'interactive.noActive': {
    en: 'no one to send to yet - /to <uin> picks a contact, /contacts lists them',
    ru: 'пока некому писать: /to <uin> выбирает контакт, /contacts показывает список',
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
