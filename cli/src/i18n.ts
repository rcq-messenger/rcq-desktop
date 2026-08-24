// One language for every human-facing line, chosen once and remembered.
//
// `rcq lang es` writes the choice into the state dir (same 0600 discipline as
// the rest of the state); unset, the environment decides: the language part of
// LC_ALL/LC_MESSAGES/LANG is mapped to the nearest of the seven the clients
// ship (en, ru, es, pt, tr, uk, zh-Hans), and anything else answers English.
//
// The table is deliberately dumb: every string lives here ONCE with all seven
// languages side by side, greppable by key or by any fragment of the text.
// No library, no plural rules, no nesting. DATA stays out of the table: uin
// numbers, history lines, contact rows, whoami VALUES, message bodies and
// the <photo ...> descriptors never pass through tr(), so pipes and scripts
// read the same bytes in any language.

import fs from 'node:fs'
import { statePath, writeFileAtomic } from './state'

/// The seven the GUI clients ship. Chinese is Simplified (zh-Hans); the code a
/// person types (`rcq lang zh`) is normalised to it.
export type Lang = 'en' | 'ru' | 'es' | 'pt' | 'tr' | 'uk' | 'zh-Hans'

/// In the order help lists them.
export const LANGS: readonly Lang[] = ['en', 'ru', 'es', 'pt', 'tr', 'uk', 'zh-Hans']

/// The codes `rcq lang` shows and accepts, `zh` standing in for zh-Hans.
export const LANG_CODES = 'en|ru|es|pt|tr|uk|zh'

const LANG_FILE = 'lang'

let _lang: Lang | null = null

/// Turn a code a person typed, or one saved on disk, into one of the seven, or
/// null when it is none of them. `zh` and `zh-Hans` both mean Simplified
/// Chinese; case and any region tail are ignored.
export function normalizeLang(raw: string): Lang | null {
  const s = raw.trim().toLowerCase()
  if (s === 'zh' || s === 'zh-hans' || s === 'zh_hans') return 'zh-Hans'
  return s === 'en' || s === 'ru' || s === 'es' || s === 'pt' || s === 'tr' || s === 'uk' ? s : null
}

/// The environment's pick for a person who has never chosen: the language part
/// of the locale, mapped by EXACT prefix to the nearest of the seven. No
/// neighbours are assumed (be is not ru), and anything unknown falls to en.
function envLang(): Lang {
  const raw = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').trim().toLowerCase()
  const code = raw.split(/[._@-]/, 1)[0]
  switch (code) {
    case 'ru':
      return 'ru'
    case 'es':
      return 'es'
    case 'pt':
      return 'pt'
    case 'tr':
      return 'tr'
    case 'uk':
      return 'uk'
    case 'zh':
      return 'zh-Hans'
    default:
      return 'en'
  }
}

export function currentLang(): Lang {
  if (_lang) return _lang
  try {
    const saved = normalizeLang(fs.readFileSync(statePath(LANG_FILE), 'utf8'))
    if (saved) return (_lang = saved)
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
  rcq                                       the conversation: live incoming + a prompt that sends
  rcq register (reg) [--nick NAME] [--island URL]   create an account, print UIN + recovery phrase
  rcq restore (res) "<24 words>" [--island URL]     restore an account from its phrase

for scripts and one-shots (stdout is data, status goes to stderr):
  rcq whoami (me)                           print uin, nickname, island, device id
  rcq nick (n) "NAME"                       rename this account
  rcq contacts (c)                          list contacts (uin, nickname, status)
  rcq who (w) <uin>                         who is this number: name, and whether you know them
  rcq find (f) "NAME"                       search the island for people by name
  rcq add (a) <uin>                         send a contact request
  rcq requests (req)                        incoming and outgoing contact requests
  rcq accept (ac) <uin>                     accept an incoming request
  rcq decline (dec) <uin>                   decline an incoming request
  rcq cancel (can) <uin>                    withdraw a request you sent
  rcq block (b) <uin> | rcq unblock (ub) <uin>   stop / resume hearing from someone
  rcq remove (rm) <uin> [--yes]             drop a contact on both sides
  rcq groups (g)                            list your rooms (id, name, members, rules)
  rcq join (j) <id>                         join an open group
  rcq leave (lv) <id>                       leave a room
  rcq create (cr) "NAME" [uin ...]          make a room with these people
  rcq invite (inv) <id> <uin>               add somebody to a room you are in
  rcq log (l) [<uin>|g<id>] [n]             last n lines of a thread from the history file
  rcq send (s) <uin>|g<id> "text" [--yes]   one-shot: drain, send, wait for the receipt, exit
                                            (--yes agrees to write to a non-contact)
  rcq watch (wt)                            read-only stream of incoming messages
  rcq export (x)                            print the history file path and line count
  rcq proxy (px) [set <addr>|clear|test]    push every connection through YOUR proxy
  rcq routes (route) [--probe|--singbox]    roads to the island: what was tried, what answered
                                            (Tor, i2p, ssh -D); plain "rcq proxy" explains it
  rcq lang (lng) [{codes}]     show or set the language
  rcq --version                             version + update check
  rcq --help                                this text

state lives in $RCQ_CLI_HOME (default ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 shows protocol detail; NO_COLOR strips colour.
`,
    ru: `rcq - консольный клиент RCQ v{version}

начните отсюда:
  rcq                                       разговор: живые входящие + строка, которая отправляет
  rcq register (reg) [--nick ИМЯ] [--island URL]    создать аккаунт, напечатать UIN и фразу восстановления
  rcq restore (res) "<24 слова>" [--island URL]     восстановить аккаунт по фразе

для скриптов и разовых команд (stdout это данные, статус идёт в stderr):
  rcq whoami (me)                           напечатать uin, ник, остров, id устройства
  rcq nick (n) "ИМЯ"                        переименовать аккаунт
  rcq contacts (c)                          список контактов (uin, ник, статус)
  rcq who (w) <uin>                         чей это номер: имя и знакомы ли вы
  rcq find (f) "ИМЯ"                        искать людей на острове по имени
  rcq add (a) <uin>                         отправить заявку в контакты
  rcq requests (req)                        входящие и исходящие заявки
  rcq accept (ac) <uin>                     принять входящую заявку
  rcq decline (dec) <uin>                   отклонить входящую заявку
  rcq cancel (can) <uin>                    отозвать свою заявку
  rcq block (b) <uin> | rcq unblock (ub) <uin>   перестать / снова получать сообщения
  rcq remove (rm) <uin> [--yes]             удалить контакт у обоих
  rcq groups (g)                            список ваших комнат (id, имя, участники, правила)
  rcq join (j) <id>                         вступить в открытую группу
  rcq leave (lv) <id>                       выйти из комнаты
  rcq create (cr) "ИМЯ" [uin ...]           создать комнату с этими людьми
  rcq invite (inv) <id> <uin>               добавить человека в вашу комнату
  rcq log (l) [<uin>|g<id>] [n]             последние n строк переписки из файла истории
  rcq send (s) <uin>|g<id> "текст" [--yes]  разово: забрать очередь, отправить, дождаться квитанции, выйти
                                            (--yes соглашается писать не-контакту)
  rcq watch (wt)                            поток входящих, только чтение
  rcq export (x)                            напечатать путь к файлу истории и число строк
  rcq proxy (px) [set <адрес>|clear|test]   гнать все соединения через ВАШ прокси
  rcq routes (route) [--probe|--singbox]    дороги к острову: что пробовали и что ответило
                                            (Tor, i2p, ssh -D); просто "rcq proxy" объяснит
  rcq lang (lng) [{codes}]     показать или сменить язык
  rcq --version                             версия + проверка обновления
  rcq --help                                этот текст

состояние живёт в $RCQ_CLI_HOME (по умолчанию ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 показывает детали протокола; NO_COLOR убирает цвет.
`,
    es: `rcq - cliente de consola de RCQ v{version}

para empezar:
  rcq                                       la conversación: entrantes en vivo + una línea que envía
  rcq register (reg) [--nick NOMBRE] [--island URL]   crear una cuenta, imprimir UIN + frase de recuperación
  rcq restore (res) "<24 palabras>" [--island URL]    restaurar una cuenta desde su frase

para scripts y comandos únicos (stdout son datos, el estado va a stderr):
  rcq whoami (me)                           imprimir uin, apodo, isla, id del dispositivo
  rcq nick (n) "NOMBRE"                     renombrar esta cuenta
  rcq contacts (c)                          listar contactos (uin, apodo, estado)
  rcq who (w) <uin>                         de quién es este número: nombre y si lo conocés
  rcq find (f) "NOMBRE"                     buscar personas en la isla por nombre
  rcq add (a) <uin>                         enviar una solicitud de contacto
  rcq requests (req)                        solicitudes de contacto entrantes y salientes
  rcq accept (ac) <uin>                     aceptar una solicitud entrante
  rcq decline (dec) <uin>                   rechazar una solicitud entrante
  rcq cancel (can) <uin>                    retirar una solicitud que enviaste
  rcq block (b) <uin> | rcq unblock (ub) <uin>   dejar de / volver a recibir de alguien
  rcq remove (rm) <uin> [--yes]             quitar un contacto de ambos lados
  rcq groups (g)                            listar tus salas (id, nombre, miembros, reglas)
  rcq join (j) <id>                         unirte a un grupo abierto
  rcq leave (lv) <id>                       salir de una sala
  rcq create (cr) "NOMBRE" [uin ...]        crear una sala con estas personas
  rcq invite (inv) <id> <uin>               agregar a alguien a una sala en la que estás
  rcq log (l) [<uin>|g<id>] [n]             últimas n líneas de un hilo del archivo de historial
  rcq send (s) <uin>|g<id> "texto" [--yes]  una vez: vaciar cola, enviar, esperar el acuse, salir
                                            (--yes acepta escribir a un no-contacto)
  rcq watch (wt)                            flujo de mensajes entrantes, solo lectura
  rcq export (x)                            imprimir la ruta del historial y el número de líneas
  rcq proxy (px) [set <dir>|clear|test]     mandar cada conexión por TU proxy
  rcq routes (route) [--probe|--singbox]    caminos a la isla: qué se probó y qué respondió
                                            (Tor, i2p, ssh -D); "rcq proxy" solo lo explica
  rcq lang (lng) [{codes}]     mostrar o cambiar el idioma
  rcq --version                             versión + comprobación de actualización
  rcq --help                                este texto

el estado vive en $RCQ_CLI_HOME (por defecto ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 muestra el detalle del protocolo; NO_COLOR quita el color.
`,
    pt: `rcq - cliente de console do RCQ v{version}

para começar:
  rcq                                       a conversa: recebidos ao vivo + uma linha que envia
  rcq register (reg) [--nick NOME] [--island URL]   criar uma conta, imprimir UIN + frase de recuperação
  rcq restore (res) "<24 palavras>" [--island URL]  restaurar uma conta a partir da frase

para scripts e comandos avulsos (stdout são dados, o status vai para stderr):
  rcq whoami (me)                           imprimir uin, apelido, ilha, id do dispositivo
  rcq nick (n) "NOME"                       renomear esta conta
  rcq contacts (c)                          listar contatos (uin, apelido, status)
  rcq who (w) <uin>                         de quem é este número: nome e se você o conhece
  rcq find (f) "NOME"                       procurar pessoas na ilha por nome
  rcq add (a) <uin>                         enviar um pedido de contato
  rcq requests (req)                        pedidos de contato recebidos e enviados
  rcq accept (ac) <uin>                     aceitar um pedido recebido
  rcq decline (dec) <uin>                   recusar um pedido recebido
  rcq cancel (can) <uin>                    retirar um pedido que você enviou
  rcq block (b) <uin> | rcq unblock (ub) <uin>   parar de / voltar a receber de alguém
  rcq remove (rm) <uin> [--yes]             remover um contato dos dois lados
  rcq groups (g)                            listar suas salas (id, nome, membros, regras)
  rcq join (j) <id>                         entrar em um grupo aberto
  rcq leave (lv) <id>                       sair de uma sala
  rcq create (cr) "NOME" [uin ...]          criar uma sala com estas pessoas
  rcq invite (inv) <id> <uin>               adicionar alguém a uma sala em que você está
  rcq log (l) [<uin>|g<id>] [n]             últimas n linhas de uma conversa do arquivo de histórico
  rcq send (s) <uin>|g<id> "texto" [--yes]  uma vez: esvaziar fila, enviar, esperar o recibo, sair
                                            (--yes concorda em escrever a um não-contato)
  rcq watch (wt)                            fluxo de mensagens recebidas, somente leitura
  rcq export (x)                            imprimir o caminho do histórico e a contagem de linhas
  rcq proxy (px) [set <end>|clear|test]     mandar cada conexão pelo SEU proxy
  rcq routes (route) [--probe|--singbox]    caminhos até a ilha: o que se tentou e o que respondeu
                                            (Tor, i2p, ssh -D); "rcq proxy" sozinho explica
  rcq lang (lng) [{codes}]     mostrar ou trocar o idioma
  rcq --version                             versão + verificação de atualização
  rcq --help                                este texto

o estado fica em $RCQ_CLI_HOME (padrão ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 mostra o detalhe do protocolo; NO_COLOR remove a cor.
`,
    tr: `rcq - RCQ konsol istemcisi v{version}

buradan başla:
  rcq                                       sohbet: canlı gelenler + gönderen bir satır
  rcq register (reg) [--nick AD] [--island URL]     hesap oluştur, UIN + kurtarma ifadesini yaz
  rcq restore (res) "<24 kelime>" [--island URL]    hesabı ifadesinden geri getir

betikler ve tek seferlik komutlar için (stdout veridir, durum stderr'e gider):
  rcq whoami (me)                           uin, takma ad, ada, cihaz id yaz
  rcq nick (n) "AD"                         bu hesabı yeniden adlandır
  rcq contacts (c)                          kişileri listele (uin, takma ad, durum)
  rcq who (w) <uin>                         bu numara kimin: adı ve onu tanıyıp tanımadığın
  rcq find (f) "AD"                         adada kişileri ada göre ara
  rcq add (a) <uin>                         kişi isteği gönder
  rcq requests (req)                        gelen ve giden kişi istekleri
  rcq accept (ac) <uin>                     gelen bir isteği kabul et
  rcq decline (dec) <uin>                   gelen bir isteği reddet
  rcq cancel (can) <uin>                    gönderdiğin bir isteği geri çek
  rcq block (b) <uin> | rcq unblock (ub) <uin>   birinden mesaj almayı durdur / sürdür
  rcq remove (rm) <uin> [--yes]             bir kişiyi iki taraftan da sil
  rcq groups (g)                            odalarını listele (id, ad, üyeler, kurallar)
  rcq join (j) <id>                         açık bir gruba katıl
  rcq leave (lv) <id>                       bir odadan ayrıl
  rcq create (cr) "AD" [uin ...]            bu kişilerle bir oda kur
  rcq invite (inv) <id> <uin>              içinde olduğun bir odaya birini ekle
  rcq log (l) [<uin>|g<id>] [n]             geçmiş dosyasından bir konuşmanın son n satırı
  rcq send (s) <uin>|g<id> "metin" [--yes]  tek sefer: kuyruğu boşalt, gönder, alındıyı bekle, çık
                                            (--yes bir kişi olmayana yazmayı kabul eder)
  rcq watch (wt)                            gelen mesaj akışı, salt okunur
  rcq export (x)                            geçmiş dosyasının yolunu ve satır sayısını yaz
  rcq proxy (px) [set <adres>|clear|test]   her bağlantıyı KENDİ proxynizden geçirin
  rcq routes (route) [--probe|--singbox]    adaya giden yollar: ne denendi, ne yanıt verdi
                                            (Tor, i2p, ssh -D); tek başına "rcq proxy" anlatır
  rcq lang (lng) [{codes}]     dili göster veya ayarla
  rcq --version                             sürüm + güncelleme kontrolü
  rcq --help                                bu metin

durum $RCQ_CLI_HOME içinde tutulur (varsayılan ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 protokol ayrıntısını gösterir; NO_COLOR rengi kaldırır.
`,
    uk: `rcq - консольний клієнт RCQ v{version}

почніть звідси:
  rcq                                       розмова: живі вхідні + рядок, який надсилає
  rcq register (reg) [--nick ІМʼЯ] [--island URL]   створити акаунт, надрукувати UIN + фразу відновлення
  rcq restore (res) "<24 слова>" [--island URL]     відновити акаунт за фразою

для скриптів і разових команд (stdout це дані, статус іде в stderr):
  rcq whoami (me)                           надрукувати uin, нік, острів, id пристрою
  rcq nick (n) "ІМʼЯ"                       перейменувати цей акаунт
  rcq contacts (c)                          список контактів (uin, нік, статус)
  rcq who (w) <uin>                         чий це номер: імʼя і чи знайомі ви
  rcq find (f) "ІМʼЯ"                       шукати людей на острові за іменем
  rcq add (a) <uin>                         надіслати запит у контакти
  rcq requests (req)                        вхідні й вихідні запити
  rcq accept (ac) <uin>                     прийняти вхідний запит
  rcq decline (dec) <uin>                   відхилити вхідний запит
  rcq cancel (can) <uin>                    відкликати свій запит
  rcq block (b) <uin> | rcq unblock (ub) <uin>   перестати / знову отримувати від когось
  rcq remove (rm) <uin> [--yes]             видалити контакт з обох боків
  rcq groups (g)                            список ваших кімнат (id, назва, учасники, правила)
  rcq join (j) <id>                         приєднатися до відкритої групи
  rcq leave (lv) <id>                       вийти з кімнати
  rcq create (cr) "ІМʼЯ" [uin ...]          створити кімнату з цими людьми
  rcq invite (inv) <id> <uin>               додати людину до вашої кімнати
  rcq log (l) [<uin>|g<id>] [n]             останні n рядків розмови з файлу історії
  rcq send (s) <uin>|g<id> "текст" [--yes]  разово: забрати чергу, надіслати, дочекатися квитанції, вийти
                                            (--yes погоджується писати не-контакту)
  rcq watch (wt)                            потік вхідних, лише читання
  rcq export (x)                            надрукувати шлях до файлу історії і кількість рядків
  rcq proxy (px) [set <адреса>|clear|test]  гнати всі зʼєднання через ВАШ проксі
  rcq routes (route) [--probe|--singbox]    дороги до острова: що пробували і що відповіло
                                            (Tor, i2p, ssh -D); просто "rcq proxy" пояснить
  rcq lang (lng) [{codes}]     показати або змінити мову
  rcq --version                             версія + перевірка оновлення
  rcq --help                                цей текст

стан живе в $RCQ_CLI_HOME (типово ~/.config/rcq), chmod 0600/0700.
RCQ_VERBOSE=1 показує деталі протоколу; NO_COLOR прибирає колір.
`,
    'zh-Hans': `rcq - RCQ 控制台客户端 v{version}

从这里开始:
  rcq                                       对话: 实时收信 + 一行用来发送
  rcq register (reg) [--nick 名称] [--island URL]   创建账号, 打印 UIN 和恢复短语
  rcq restore (res) "<24 个词>" [--island URL]      用短语恢复账号

用于脚本和一次性命令 (stdout 是数据, 状态输出到 stderr):
  rcq whoami (me)                           打印 uin, 昵称, 服务器, 设备 id
  rcq nick (n) "名称"                       重命名此账号
  rcq contacts (c)                          列出联系人 (uin, 昵称, 状态)
  rcq who (w) <uin>                         这个号码是谁: 名字, 以及你是否认识
  rcq find (f) "名称"                       在服务器上按名字找人
  rcq add (a) <uin>                         发送联系人请求
  rcq requests (req)                        收到和发出的联系人请求
  rcq accept (ac) <uin>                     接受一条收到的请求
  rcq decline (dec) <uin>                   拒绝一条收到的请求
  rcq cancel (can) <uin>                    撤回你发出的请求
  rcq block (b) <uin> | rcq unblock (ub) <uin>   停止 / 恢复接收某人的消息
  rcq remove (rm) <uin> [--yes]             双向删除一个联系人
  rcq groups (g)                            列出你的群 (id, 名称, 成员, 规则)
  rcq join (j) <id>                         加入一个开放的群
  rcq leave (lv) <id>                       退出一个群
  rcq create (cr) "名称" [uin ...]          用这些人创建一个群
  rcq invite (inv) <id> <uin>               把某人加入你所在的群
  rcq log (l) [<uin>|g<id>] [n]             历史文件里某个会话的最后 n 行
  rcq send (s) <uin>|g<id> "文本" [--yes]   一次性: 取队列, 发送, 等回执, 退出
                                            (--yes 同意给非联系人写信)
  rcq watch (wt)                            收信流, 只读
  rcq export (x)                            打印历史文件路径和行数
  rcq proxy (px) [set <地址>|clear|test]     让每个连接都走你自己的代理
  rcq routes (route) [--probe|--singbox]    通往服务器的路线：试过什么，什么给了回应
                                            (Tor, i2p, ssh -D); 单写 "rcq proxy" 会解释
  rcq lang (lng) [{codes}]     显示或设置语言
  rcq --version                             版本 + 更新检查
  rcq --help                                此文本

状态存放在 $RCQ_CLI_HOME (默认 ~/.config/rcq), chmod 0600/0700。
RCQ_VERBOSE=1 显示协议细节; NO_COLOR 去掉颜色。
`,
  },

  'lang.usage': {
    en: 'usage: rcq lang [{codes}]  (unset, the language follows LANG/LC_ALL)',
    ru: 'использование: rcq lang [{codes}]  (без выбора язык берётся из LANG/LC_ALL)',
    es: 'uso: rcq lang [{codes}]  (sin elegir, el idioma sigue a LANG/LC_ALL)',
    pt: 'uso: rcq lang [{codes}]  (sem escolha, o idioma segue LANG/LC_ALL)',
    tr: 'kullanım: rcq lang [{codes}]  (seçilmezse dil LANG/LC_ALL ile belirlenir)',
    uk: 'використання: rcq lang [{codes}]  (без вибору мова береться з LANG/LC_ALL)',
    'zh-Hans': '用法: rcq lang [{codes}]  (未选择时语言跟随 LANG/LC_ALL)',
  },
  'lang.invalid': {
    en: "lang takes one of {codes}, not '{arg}'",
    ru: "lang принимает одно из {codes}, а не '{arg}'",
    es: "lang toma uno de {codes}, no '{arg}'",
    pt: "lang aceita um de {codes}, não '{arg}'",
    tr: "lang şunlardan birini alır {codes}, '{arg}' değil",
    uk: "lang приймає одне з {codes}, а не '{arg}'",
    'zh-Hans': "lang 只接受 {codes} 之一, 不是 '{arg}'",
  },
  'lang.set': {
    en: 'language: {lang}',
    ru: 'язык: {lang}',
    es: 'idioma: {lang}',
    pt: 'idioma: {lang}',
    tr: 'dil: {lang}',
    uk: 'мова: {lang}',
    'zh-Hans': '语言: {lang}',
  },

  'proxy.usage': {
    en: `usage: rcq proxy [show | set <address> | clear | test]
  address: socks5://127.0.0.1:9050 (or just 127.0.0.1:9050), http://host:8118,
           or a preset: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  the proxy is stored in $RCQ_CLI_HOME and used by every command after it,
  including the update check. RCQ_PROXY=off turns it off for one command.`,
    ru: `использование: rcq proxy [show | set <адрес> | clear | test]
  адрес: socks5://127.0.0.1:9050 (или просто 127.0.0.1:9050), http://host:8118,
         либо готовое имя: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  прокси лежит в $RCQ_CLI_HOME и работает во всех следующих командах,
  включая проверку обновлений. RCQ_PROXY=off выключает его на одну команду.`,
    es: `uso: rcq proxy [show | set <dirección> | clear | test]
  dirección: socks5://127.0.0.1:9050 (o solo 127.0.0.1:9050), http://host:8118,
             o un preajuste: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  el proxy se guarda en $RCQ_CLI_HOME y lo usa cada comando posterior,
  incluida la comprobación de actualización. RCQ_PROXY=off lo apaga una vez.`,
    pt: `uso: rcq proxy [show | set <endereço> | clear | test]
  endereço: socks5://127.0.0.1:9050 (ou só 127.0.0.1:9050), http://host:8118,
            ou um preset: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  o proxy fica em $RCQ_CLI_HOME e é usado por todo comando seguinte,
  inclusive a verificação de atualização. RCQ_PROXY=off desliga por um comando.`,
    tr: `kullanım: rcq proxy [show | set <adres> | clear | test]
  adres: socks5://127.0.0.1:9050 (ya da sadece 127.0.0.1:9050), http://host:8118,
         veya hazır bir ad: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  proxy $RCQ_CLI_HOME içinde durur ve sonraki her komutta kullanılır,
  güncelleme kontrolü dahil. RCQ_PROXY=off tek komut için kapatır.`,
    uk: `використання: rcq proxy [show | set <адреса> | clear | test]
  адреса: socks5://127.0.0.1:9050 (або просто 127.0.0.1:9050), http://host:8118,
          чи готова назва: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  проксі лежить у $RCQ_CLI_HOME і працює в усіх наступних командах,
  разом з перевіркою оновлень. RCQ_PROXY=off вимикає його на одну команду.`,
    'zh-Hans': `用法: rcq proxy [show | set <地址> | clear | test]
  地址: socks5://127.0.0.1:9050 (或只写 127.0.0.1:9050), http://host:8118,
        或预设名: tor (Orbot, 127.0.0.1:9050), i2p (i2pd, 127.0.0.1:4447)
  代理存放在 $RCQ_CLI_HOME, 之后每条命令都会走它, 包括更新检查。
  RCQ_PROXY=off 可以只关掉一条命令的代理。`,
  },
  'proxy.on': {
    en: 'every connection goes through your proxy',
    ru: 'все соединения идут через ваш прокси',
    es: 'todas las conexiones pasan por tu proxy',
    pt: 'todas as conexões passam pelo seu proxy',
    tr: 'her bağlantı proxy üzerinden gidiyor',
    uk: 'усі зʼєднання йдуть через ваш проксі',
    'zh-Hans': '所有连接都走你的代理',
  },
  'proxy.off': {
    en: 'no proxy: every connection goes straight to the island',
    ru: 'прокси нет: все соединения идут прямо на остров',
    es: 'sin proxy: cada conexión va directo a la isla',
    pt: 'sem proxy: cada conexão vai direto para a ilha',
    tr: 'proxy yok: her bağlantı doğrudan adaya gidiyor',
    uk: 'проксі немає: усі зʼєднання йдуть прямо на острів',
    'zh-Hans': '没有代理: 每个连接都直连服务器',
  },
  'proxy.set': {
    en: 'proxy: {url} - the next command already uses it',
    ru: 'прокси: {url} - следующая команда уже идёт через него',
    es: 'proxy: {url} - el siguiente comando ya lo usa',
    pt: 'proxy: {url} - o próximo comando já o usa',
    tr: 'proxy: {url} - sonraki komut zaten bunu kullanıyor',
    uk: 'проксі: {url} - наступна команда вже йде через нього',
    'zh-Hans': '代理: {url} - 下一条命令就会走它',
  },
  'proxy.cleared': {
    en: 'proxy cleared: connections go straight to the island again',
    ru: 'прокси убран: соединения снова идут прямо на остров',
    es: 'proxy borrado: las conexiones vuelven a ir directo a la isla',
    pt: 'proxy removido: as conexões voltam a ir direto para a ilha',
    tr: 'proxy silindi: bağlantılar yine doğrudan adaya gidiyor',
    uk: 'проксі прибрано: зʼєднання знову йдуть прямо на острів',
    'zh-Hans': '代理已清除: 连接重新直连服务器',
  },
  'proxy.nothingToClear': {
    en: 'no proxy was set',
    ru: 'прокси и не было',
    es: 'no había proxy',
    pt: 'não havia proxy',
    tr: 'zaten proxy yoktu',
    uk: 'проксі й не було',
    'zh-Hans': '本来就没有代理',
  },
  'proxy.needsUrl': {
    en: 'proxy set needs an address, for example: rcq proxy set tor',
    ru: 'proxy set требует адрес, например: rcq proxy set tor',
    es: 'proxy set necesita una dirección, por ejemplo: rcq proxy set tor',
    pt: 'proxy set precisa de um endereço, por exemplo: rcq proxy set tor',
    tr: 'proxy set bir adres ister, örneğin: rcq proxy set tor',
    uk: 'proxy set потребує адресу, наприклад: rcq proxy set tor',
    'zh-Hans': 'proxy set 需要一个地址, 例如: rcq proxy set tor',
  },
  'proxy.syntax': {
    en: "'{arg}' is not a proxy address. Try socks5://127.0.0.1:9050, or just tor",
    ru: "'{arg}' не похоже на адрес прокси. Например: socks5://127.0.0.1:9050 или просто tor",
    es: "'{arg}' no es una dirección de proxy. Probá socks5://127.0.0.1:9050, o solo tor",
    pt: "'{arg}' não é um endereço de proxy. Tente socks5://127.0.0.1:9050, ou só tor",
    tr: "'{arg}' bir proxy adresi değil. socks5://127.0.0.1:9050 deneyin, ya da sadece tor",
    uk: "'{arg}' не схоже на адресу проксі. Спробуйте socks5://127.0.0.1:9050 або просто tor",
    'zh-Hans': "'{arg}' 不是代理地址。试试 socks5://127.0.0.1:9050, 或者直接写 tor",
  },
  'proxy.scheme': {
    en: '{scheme}:// proxies do not work here. Node carries this traffic and it takes socks5://, http:// and https:// only',
    ru: 'прокси {scheme}:// здесь не работают. Трафик несёт сам Node, а он понимает только socks5://, http:// и https://',
    es: 'los proxies {scheme}:// no funcionan acá. Node lleva este tráfico y solo acepta socks5://, http:// y https://',
    pt: 'proxies {scheme}:// não funcionam aqui. O Node carrega este tráfego e só aceita socks5://, http:// e https://',
    tr: '{scheme}:// proxyleri burada çalışmaz. Bu trafiği Node taşır ve yalnızca socks5://, http:// ve https:// kabul eder',
    uk: 'проксі {scheme}:// тут не працюють. Трафік несе сам Node, а він розуміє лише socks5://, http:// і https://',
    'zh-Hans': '{scheme}:// 代理在这里不能用。这条流量由 Node 承载, 它只接受 socks5://、http:// 和 https://',
  },
  'proxy.testing': {
    en: 'testing {url} -> {island}',
    ru: 'проверяю {url} -> {island}',
    es: 'probando {url} -> {island}',
    pt: 'testando {url} -> {island}',
    tr: 'deneniyor {url} -> {island}',
    uk: 'перевіряю {url} -> {island}',
    'zh-Hans': '正在测试 {url} -> {island}',
  },
  'proxy.ok': {
    en: 'it works: {island} answered through the proxy in {ms} ms',
    ru: 'работает: {island} ответил через прокси за {ms} мс',
    es: 'funciona: {island} respondió a través del proxy en {ms} ms',
    pt: 'funciona: {island} respondeu através do proxy em {ms} ms',
    tr: 'çalışıyor: {island} proxy üzerinden {ms} ms içinde yanıt verdi',
    uk: 'працює: {island} відповів через проксі за {ms} мс',
    'zh-Hans': '可用: {island} 通过代理在 {ms} 毫秒内作出了回应',
  },
  'proxy.failRefused': {
    en: 'nothing is listening at {addr}. Is the proxy (Tor, i2pd, your tunnel) actually running?',
    ru: 'на {addr} никто не слушает. Прокси (Tor, i2pd, ваш туннель) точно запущен?',
    es: 'nadie escucha en {addr}. ¿El proxy (Tor, i2pd, tu túnel) está corriendo?',
    pt: 'ninguém escuta em {addr}. O proxy (Tor, i2pd, seu túnel) está mesmo rodando?',
    tr: '{addr} adresinde kimse dinlemiyor. Proxy (Tor, i2pd, tüneliniz) gerçekten çalışıyor mu?',
    uk: 'на {addr} ніхто не слухає. Проксі (Tor, i2pd, ваш тунель) справді запущений?',
    'zh-Hans': '{addr} 上没有人在监听。代理 (Tor、i2pd 或你的隧道) 真的在运行吗?',
  },
  'proxy.failNotSocks': {
    en: '{addr} answered, but not as a SOCKS5 proxy. Wrong port, or an HTTP proxy that wants http://?',
    ru: '{addr} ответил, но не как SOCKS5-прокси. Не тот порт, или это HTTP-прокси и нужно http://?',
    es: '{addr} respondió, pero no como proxy SOCKS5. ¿Puerto equivocado, o un proxy HTTP que quiere http://?',
    pt: '{addr} respondeu, mas não como proxy SOCKS5. Porta errada, ou um proxy HTTP que quer http://?',
    tr: '{addr} yanıt verdi ama SOCKS5 proxy gibi değil. Yanlış port mu, yoksa http:// isteyen bir HTTP proxy mi?',
    uk: '{addr} відповів, але не як SOCKS5-проксі. Не той порт, чи це HTTP-проксі і потрібен http://?',
    'zh-Hans': '{addr} 有回应, 但不是 SOCKS5 代理。端口不对, 还是一个需要 http:// 的 HTTP 代理?',
  },
  'proxy.failNotHttp': {
    en: '{addr} answered, but not as an HTTP proxy. Wrong port, or a SOCKS5 proxy that wants socks5://?',
    ru: '{addr} ответил, но не как HTTP-прокси. Не тот порт, или это SOCKS5 и нужно socks5://?',
    es: '{addr} respondió, pero no como proxy HTTP. ¿Puerto equivocado, o un proxy SOCKS5 que quiere socks5://?',
    pt: '{addr} respondeu, mas não como proxy HTTP. Porta errada, ou um proxy SOCKS5 que quer socks5://?',
    tr: '{addr} yanıt verdi ama HTTP proxy gibi değil. Yanlış port mu, yoksa socks5:// isteyen bir SOCKS5 proxy mi?',
    uk: '{addr} відповів, але не як HTTP-проксі. Не той порт, чи це SOCKS5 і потрібен socks5://?',
    'zh-Hans': '{addr} 有回应, 但不是 HTTP 代理。端口不对, 还是一个需要 socks5:// 的 SOCKS5 代理?',
  },
  'proxy.failTimeout': {
    en: 'the proxy took the connection and nothing came back in {ms} ms. It may not be able to reach {island} either',
    ru: 'прокси принял соединение, но за {ms} мс ничего не вернулось. Возможно, он и сам не достаёт до {island}',
    es: 'el proxy aceptó la conexión y no volvió nada en {ms} ms. Puede que tampoco alcance {island}',
    pt: 'o proxy aceitou a conexão e nada voltou em {ms} ms. Talvez ele também não alcance {island}',
    tr: 'proxy bağlantıyı aldı ama {ms} ms içinde hiçbir şey dönmedi. {island} adresine kendisi de erişemiyor olabilir',
    uk: 'проксі прийняв зʼєднання, але за {ms} мс нічого не повернулося. Можливо, він і сам не дістає до {island}',
    'zh-Hans': '代理接受了连接, 但 {ms} 毫秒内什么都没回来。它可能也到不了 {island}',
  },
  'proxy.failStatus': {
    en: 'the proxy reached {island}, which answered {status} instead of a health check',
    ru: 'прокси дошёл до {island}, но тот ответил {status} вместо проверки здоровья',
    es: 'el proxy llegó a {island}, que respondió {status} en vez de un chequeo de salud',
    pt: 'o proxy chegou a {island}, que respondeu {status} em vez de um health check',
    tr: 'proxy {island} adresine ulaştı ama oradan sağlık yanıtı yerine {status} geldi',
    uk: 'проксі дійшов до {island}, але той відповів {status} замість перевірки здоровʼя',
    'zh-Hans': '代理到达了 {island}, 但它返回了 {status} 而不是健康检查',
  },
  'proxy.failOther': {
    en: 'the proxy did not carry traffic to {island}: {detail}',
    ru: 'прокси не донёс трафик до {island}: {detail}',
    es: 'el proxy no llevó el tráfico hasta {island}: {detail}',
    pt: 'o proxy não levou o tráfego até {island}: {detail}',
    tr: 'proxy trafiği {island} adresine taşımadı: {detail}',
    uk: 'проксі не доніс трафік до {island}: {detail}',
    'zh-Hans': '代理没有把流量送到 {island}: {detail}',
  },
  'proxy.ignored': {
    en: 'this Node ({version}) ignores the proxy environment: it needs Node 24 or newer. NOTHING is being proxied',
    ru: 'этот Node ({version}) игнорирует переменные прокси: нужен Node 24 или новее. НИЧЕГО через прокси не идёт',
    es: 'este Node ({version}) ignora el entorno de proxy: hace falta Node 24 o más nuevo. NADA pasa por el proxy',
    pt: 'este Node ({version}) ignora o ambiente de proxy: precisa de Node 24 ou mais novo. NADA passa pelo proxy',
    tr: 'bu Node ({version}) proxy ortam değişkenlerini yok sayıyor: Node 24 veya üstü gerekir. HİÇBİR ŞEY proxy üzerinden gitmiyor',
    uk: 'цей Node ({version}) ігнорує змінні проксі: потрібен Node 24 або новіший. НІЧОГО через проксі не йде',
    'zh-Hans': '这个 Node ({version}) 会忽略代理环境变量: 需要 Node 24 或更新的版本。现在没有任何流量走代理',
  },
  'proxy.refusedUnsupported': {
    en: 'refusing to run this command with a proxy that does nothing: upgrade to Node 24+, or run with RCQ_PROXY=off if a direct connection is acceptable',
    ru: 'команда не будет выполнена с прокси, который ничего не делает: поставьте Node 24+ или запустите с RCQ_PROXY=off, если прямое соединение вас устраивает',
    es: 'no ejecuto este comando con un proxy que no hace nada: actualizá a Node 24+, o corré con RCQ_PROXY=off si aceptás una conexión directa',
    pt: 'não vou rodar este comando com um proxy que não faz nada: atualize para Node 24+, ou rode com RCQ_PROXY=off se aceitar uma conexão direta',
    tr: 'hiçbir şey yapmayan bir proxy ile bu komutu çalıştırmıyorum: Node 24+ sürümüne geçin ya da doğrudan bağlantıyı kabul ediyorsanız RCQ_PROXY=off ile çalıştırın',
    uk: 'команда не виконається з проксі, який нічого не робить: поставте Node 24+ або запустіть з RCQ_PROXY=off, якщо пряме зʼєднання вас влаштовує',
    'zh-Hans': '不会在一个形同虚设的代理下执行这条命令: 请升级到 Node 24+, 或者如果你接受直连, 用 RCQ_PROXY=off 运行',
  },
  'proxy.refusedBadValue': {
    en: 'the proxy in {source} cannot be used, and this command will not fall back to a direct connection: fix it with `rcq proxy set <address>`, or use RCQ_PROXY=off',
    ru: 'прокси из {source} использовать нельзя, а прямым соединением команда не пойдёт: поправьте `rcq proxy set <адрес>` или укажите RCQ_PROXY=off',
    es: 'el proxy de {source} no se puede usar, y este comando no va a caer a una conexión directa: arreglalo con `rcq proxy set <dirección>`, o usá RCQ_PROXY=off',
    pt: 'o proxy de {source} não pode ser usado, e este comando não vai cair para uma conexão direta: corrija com `rcq proxy set <endereço>`, ou use RCQ_PROXY=off',
    tr: '{source} içindeki proxy kullanılamaz ve bu komut doğrudan bağlantıya düşmeyecek: `rcq proxy set <adres>` ile düzeltin ya da RCQ_PROXY=off kullanın',
    uk: 'проксі з {source} використати не можна, і прямим зʼєднанням команда не піде: виправте через `rcq proxy set <адреса>` або вкажіть RCQ_PROXY=off',
    'zh-Hans': '{source} 里的代理无法使用, 而这条命令不会退回到直连: 用 `rcq proxy set <地址>` 改好, 或者使用 RCQ_PROXY=off',
  },
  'proxy.caveat': {
    en: 'what this does not do: the island still sees a connection, from the proxy address instead of yours, and this is not RCQ relay circumvention',
    ru: 'чего это не даёт: остров всё равно видит соединение, только с адреса прокси, а не вашего, и это не обход через релеи RCQ',
    es: 'lo que no hace: la isla igual ve una conexión, desde la dirección del proxy en vez de la tuya, y esto no es la evasión por relés de RCQ',
    pt: 'o que isto não faz: a ilha ainda vê uma conexão, do endereço do proxy em vez do seu, e isto não é a evasão pelos relés do RCQ',
    tr: 'bunun yapmadığı şey: ada yine bir bağlantı görür, sizinki yerine proxy adresinden, ve bu RCQ relay atlatması değildir',
    uk: 'чого це не дає: острів усе одно бачить зʼєднання, лише з адреси проксі, а не вашої, і це не обхід через релеї RCQ',
    'zh-Hans': '它做不到的事: 服务器仍然看得到一个连接, 只是来自代理地址而不是你的地址, 而且这不是 RCQ 的中继绕行',
  },
  'label.proxy': {
    en: 'proxy',
    ru: 'прокси',
    es: 'proxy',
    pt: 'proxy',
    tr: 'proxy',
    uk: 'проксі',
    'zh-Hans': '代理',
  },
  'interactive.proxy': {
    en: 'proxy: {url} (change it with `rcq proxy` outside; it engages when rcq starts)',
    ru: 'прокси: {url} (менять через `rcq proxy` снаружи; включается при старте rcq)',
    es: 'proxy: {url} (cambialo con `rcq proxy` afuera; se activa al iniciar rcq)',
    pt: 'proxy: {url} (mude com `rcq proxy` fora daqui; entra em ação quando o rcq inicia)',
    tr: 'proxy: {url} (dışarıda `rcq proxy` ile değiştirin; rcq başlarken devreye girer)',
    uk: 'проксі: {url} (міняти через `rcq proxy` ззовні; вмикається на старті rcq)',
    'zh-Hans': '代理: {url} (在外面用 `rcq proxy` 修改; 它在 rcq 启动时生效)',
  },

  'args.flagNeedsValue': {
    en: '{flag} needs a value',
    ru: '{flag} требует значение',
    es: '{flag} necesita un valor',
    pt: '{flag} precisa de um valor',
    tr: '{flag} bir değer ister',
    uk: '{flag} потребує значення',
    'zh-Hans': '{flag} 需要一个值',
  },
  'args.noCommand': {
    en: 'no command',
    ru: 'нет команды',
    es: 'ningún comando',
    pt: 'nenhum comando',
    tr: 'komut yok',
    uk: 'немає команди',
    'zh-Hans': '没有命令',
  },
  'args.unknownCmd': {
    en: "unknown command '{cmd}'",
    ru: "неизвестная команда '{cmd}'",
    es: "comando desconocido '{cmd}'",
    pt: "comando desconhecido '{cmd}'",
    tr: "bilinmeyen komut '{cmd}'",
    uk: "невідома команда '{cmd}'",
    'zh-Hans': "未知命令 '{cmd}'",
  },

  'err.noAccount': {
    en: "no account here - run 'rcq register' or 'rcq restore' first",
    ru: "здесь нет аккаунта, сначала 'rcq register' или 'rcq restore'",
    es: "no hay cuenta aquí, ejecutá primero 'rcq register' o 'rcq restore'",
    pt: "não há conta aqui, rode primeiro 'rcq register' ou 'rcq restore'",
    tr: "burada hesap yok, önce 'rcq register' veya 'rcq restore' çalıştır",
    uk: "тут немає акаунта, спершу 'rcq register' або 'rcq restore'",
    'zh-Hans': "这里没有账号, 先运行 'rcq register' 或 'rcq restore'",
  },
  'err.accountExists': {
    en: "an account already lives here - 'rcq whoami'. Use RCQ_CLI_HOME for a second one",
    ru: "аккаунт здесь уже есть, см. 'rcq whoami'. Второй заводится через RCQ_CLI_HOME",
    es: "ya hay una cuenta aquí, 'rcq whoami'. Usá RCQ_CLI_HOME para una segunda",
    pt: "já existe uma conta aqui, 'rcq whoami'. Use RCQ_CLI_HOME para uma segunda",
    tr: "burada zaten bir hesap var, 'rcq whoami'. İkincisi için RCQ_CLI_HOME kullan",
    uk: "тут уже є акаунт, 'rcq whoami'. Другий заводиться через RCQ_CLI_HOME",
    'zh-Hans': "这里已经有一个账号, 见 'rcq whoami'。第二个用 RCQ_CLI_HOME",
  },
  'err.sessionRefused': {
    en: 'the island refused this session (revoked or account gone)',
    ru: 'остров отверг эту сессию (отозвана или аккаунт удалён)',
    es: 'la isla rechazó esta sesión (revocada o cuenta eliminada)',
    pt: 'a ilha recusou esta sessão (revogada ou conta removida)',
    tr: 'ada bu oturumu reddetti (iptal edildi ya da hesap yok)',
    uk: 'острів відхилив цю сесію (відкликана або акаунт видалено)',
    'zh-Hans': '服务器拒绝了此会话 (已吊销或账号已删除)',
  },
  'err.mintFailed': {
    en: 'could not mint a session token (island unreachable?)',
    ru: 'не удалось получить токен сессии (остров недоступен?)',
    es: 'no se pudo emitir un token de sesión (isla inaccesible?)',
    pt: 'não foi possível emitir um token de sessão (ilha inacessível?)',
    tr: 'oturum belirteci alınamadı (adaya ulaşılamıyor mu?)',
    uk: 'не вдалося отримати токен сесії (острів недоступний?)',
    'zh-Hans': '无法获取会话令牌 (服务器无法访问?)',
  },
  'err.sessionRejected': {
    en: 'the island rejected this session (unlinked or revoked)',
    ru: 'остров отклонил эту сессию (отвязана или отозвана)',
    es: 'la isla rechazó esta sesión (desvinculada o revocada)',
    pt: 'a ilha rejeitou esta sessão (desvinculada ou revogada)',
    tr: 'ada bu oturumu geri çevirdi (bağlantısı kesildi ya da iptal edildi)',
    uk: 'острів відхилив цю сесію (відвʼязана або відкликана)',
    'zh-Hans': '服务器拒绝了此会话 (已解绑或已吊销)',
  },

  'label.phrase': { en: 'phrase', ru: 'фраза', es: 'frase', pt: 'frase', tr: 'ifade', uk: 'фраза', 'zh-Hans': '短语' },
  'label.nickname': { en: 'nickname', ru: 'ник', es: 'apodo', pt: 'apelido', tr: 'takma ad', uk: 'нік', 'zh-Hans': '昵称' },
  'label.island': { en: 'island', ru: 'остров', es: 'isla', pt: 'ilha', tr: 'ada', uk: 'острів', 'zh-Hans': '服务器' },
  'label.device': { en: 'device', ru: 'устройство', es: 'dispositivo', pt: 'dispositivo', tr: 'cihaz', uk: 'пристрій', 'zh-Hans': '设备' },
  'label.route': { en: 'route', ru: 'маршрут', es: 'ruta', pt: 'rota', tr: 'rota', uk: 'маршрут', 'zh-Hans': '路线' },
  'label.front': { en: 'front', ru: 'фронт', es: 'frente', pt: 'frente', tr: 'cephe', uk: 'фронт', 'zh-Hans': '前置域名' },
  'label.relays': { en: 'relays', ru: 'релеи', es: 'relés', pt: 'relés', tr: 'röleler', uk: 'релеї', 'zh-Hans': '中继' },
  'label.sources': { en: 'sources', ru: 'источники', es: 'fuentes', pt: 'fontes', tr: 'kaynaklar', uk: 'джерела', 'zh-Hans': '来源' },
  'label.probe': { en: 'probe', ru: 'проба', es: 'sonda', pt: 'sonda', tr: 'sinama', uk: 'проба', 'zh-Hans': '探测' },
  'label.singbox': { en: 'sing-box', ru: 'sing-box', es: 'sing-box', pt: 'sing-box', tr: 'sing-box', uk: 'sing-box', 'zh-Hans': 'sing-box' },

  // rcq routes - the ladder of roads to the island. Verdicts and labels only;
  // hostnames, versions, milliseconds and rung names are DATA and stay bare.
  'routes.ok': { en: 'ok', ru: 'отвечает', es: 'responde', pt: 'responde', tr: 'yanit veriyor', uk: 'відповідає', 'zh-Hans': '可达' },
  'routes.blocked': { en: 'no answer', ru: 'нет ответа', es: 'sin respuesta', pt: 'sem resposta', tr: 'yanit yok', uk: 'немає відповіді', 'zh-Hans': '无响应' },
  'routes.skipped': { en: 'skipped', ru: 'пропущен', es: 'omitido', pt: 'ignorado', tr: 'atlandi', uk: 'пропущено', 'zh-Hans': '已跳过' },
  'routes.notTried': { en: 'not tried', ru: 'не понадобился', es: 'no hizo falta', pt: 'nao foi preciso', tr: 'gerekmedi', uk: 'не знадобився', 'zh-Hans': '未尝试' },

  'routes.signedConfig': {
    en: 'signed config v{version}',
    ru: 'подписанный список v{version}',
    es: 'lista firmada v{version}',
    pt: 'lista assinada v{version}',
    tr: 'imzali liste v{version}',
    uk: 'підписаний список v{version}',
    'zh-Hans': '已签名配置 v{version}',
  },
  'routes.bundledSeed': {
    en: 'built-in list, no signed payload yet',
    ru: 'встроенный список, подписанного пока не было',
    es: 'lista incorporada, aun sin payload firmado',
    pt: 'lista embutida, ainda sem payload assinado',
    tr: 'gomulu liste, henuz imzali bir yuk yok',
    uk: 'вбудований список, підписаного ще не було',
    'zh-Hans': '内置列表，尚未取得已签名配置',
  },
  'routes.lastWalk': {
    en: 'last walk:',
    ru: 'последний обход:',
    es: 'ultimo recorrido:',
    pt: 'ultima passagem:',
    tr: 'son deneme:',
    uk: 'останній обхід:',
    'zh-Hans': '上次探测：',
  },
  'routes.neverWalked': {
    en: 'the ladder has not been walked yet: rcq routes --probe',
    ru: 'лестницу ещё не проходили: rcq routes --probe',
    es: 'la escalera aun no se ha recorrido: rcq routes --probe',
    pt: 'a escada ainda nao foi percorrida: rcq routes --probe',
    tr: 'merdiven henuz denenmedi: rcq routes --probe',
    uk: 'драбину ще не проходили: rcq routes --probe',
    'zh-Hans': '还没有走过这条路线阶梯：rcq routes --probe',
  },

  'routes.noEmbeddedTransport': {
    en:
      'the relays need sing-box, which this client cannot embed: Node has no way to speak\n' +
      'VLESS+Reality or Hysteria2. `rcq routes --singbox` writes a config for a sing-box you\n' +
      'install yourself; point `rcq proxy` at it and every byte rides the relays. The onion\n' +
      'chain is written there too, and sing-box is what builds and carries it.',
    ru:
      'релеям нужен sing-box, а встроить его сюда нельзя: Node не умеет ни VLESS+Reality,\n' +
      'ни Hysteria2. `rcq routes --singbox` пишет конфиг для sing-box, который вы ставите\n' +
      'сами; направьте на него `rcq proxy` и весь трафик пойдёт через релеи. Луковая цепочка\n' +
      'тоже пишется туда, но строит и держит её sing-box, а не мы.',
    es:
      'los reles necesitan sing-box, que este cliente no puede incrustar: Node no habla\n' +
      'VLESS+Reality ni Hysteria2. `rcq routes --singbox` escribe la configuracion para un\n' +
      'sing-box que instalas tu; apunta `rcq proxy` a el y todo el trafico pasa por los reles.\n' +
      'La cadena onion tambien se escribe alli, y quien la construye es sing-box.',
    pt:
      'os reles precisam do sing-box, que este cliente nao pode embutir: o Node nao fala\n' +
      'VLESS+Reality nem Hysteria2. `rcq routes --singbox` escreve a configuracao de um\n' +
      'sing-box que voce instala; aponte `rcq proxy` para ele e tudo passa pelos reles.\n' +
      'A cadeia onion tambem vai no arquivo, e quem a constroi e o sing-box.',
    tr:
      'roleler sing-box ister, bu istemci onu icine alamaz: Node ne VLESS+Reality ne de\n' +
      'Hysteria2 konusur. `rcq routes --singbox` kendi kurdugunuz bir sing-box icin yapilandirma\n' +
      'yazar; `rcq proxy` ile ona baglayin, tum trafik rolelerden gecer. Onion zinciri de o\n' +
      'dosyaya yazilir, kuran ve tasiyan sing-box olur.',
    uk:
      'релеям потрібен sing-box, а вбудувати його сюди не можна: Node не вміє ні VLESS+Reality,\n' +
      'ні Hysteria2. `rcq routes --singbox` пише конфіг для sing-box, який ви ставите самі;\n' +
      'спрямуйте на нього `rcq proxy` і весь трафік піде через релеї. Цибулевий ланцюг теж\n' +
      'пишеться туди, але будує і тримає його sing-box, а не ми.',
    'zh-Hans':
      '中继需要 sing-box，本客户端无法内嵌它：Node 既不会 VLESS+Reality 也不会 Hysteria2。\n' +
      '`rcq routes --singbox` 会为你自行安装的 sing-box 写出配置；再用 `rcq proxy` 指向它，\n' +
      '所有流量就都走中继。洋葱链路也写在同一个配置里，真正搭建并承载它的是 sing-box。',
  },
  'routes.singboxMissing': {
    en: 'not on PATH: install it, or point rcq proxy at one running elsewhere',
    ru: 'нет в PATH: поставьте его или направьте rcq proxy на уже запущенный',
    es: 'no esta en PATH: instalalo, o apunta rcq proxy a uno que ya corra',
    pt: 'nao esta no PATH: instale, ou aponte rcq proxy para um que ja rode',
    tr: 'PATH uzerinde yok: kurun ya da rcq proxy ile calisan birine baglanin',
    uk: 'немає в PATH: поставте його або спрямуйте rcq proxy на вже запущений',
    'zh-Hans': '不在 PATH 中：请安装，或用 rcq proxy 指向别处已运行的实例',
  },
  'routes.usage': {
    en: `usage: rcq routes [--probe] [--refresh] [--singbox [--out FILE] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    walk the ladder now instead of reusing the last answer
  --refresh  re-fetch and verify the signed relay list
  --singbox  print (or write) a sing-box config built from that list`,
    ru: `использование: rcq routes [--probe] [--refresh] [--singbox [--out ФАЙЛ] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    пройти лестницу сейчас, а не брать прошлый ответ
  --refresh  заново скачать и проверить подписанный список релеев
  --singbox  напечатать (или записать) конфиг sing-box по этому списку`,
    es: `uso: rcq routes [--probe] [--refresh] [--singbox [--out ARCHIVO] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    recorrer la escalera ahora en vez de reusar la respuesta anterior
  --refresh  volver a bajar y verificar la lista firmada de reles
  --singbox  imprimir (o escribir) una configuracion de sing-box con esa lista`,
    pt: `uso: rcq routes [--probe] [--refresh] [--singbox [--out ARQUIVO] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    percorrer a escada agora em vez de reusar a resposta anterior
  --refresh  baixar e verificar de novo a lista assinada de reles
  --singbox  imprimir (ou gravar) uma configuracao de sing-box a partir dela`,
    tr: `kullanim: rcq routes [--probe] [--refresh] [--singbox [--out DOSYA] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    onceki yaniti kullanmak yerine merdiveni simdi dene
  --refresh  imzali role listesini yeniden indir ve dogrula
  --singbox  o listeden bir sing-box yapilandirmasi yaz (ya da yazdir)`,
    uk: `використання: rcq routes [--probe] [--refresh] [--singbox [--out ФАЙЛ] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    пройти драбину зараз, а не брати минулу відповідь
  --refresh  заново завантажити і перевірити підписаний список релеїв
  --singbox  надрукувати (або записати) конфіг sing-box за цим списком`,
    'zh-Hans': `用法: rcq routes [--probe] [--refresh] [--singbox [--out 文件] [--port N] [--onion|--no-onion] [--bridges]]
  --probe    立即重走一遍阶梯，而不是沿用上次的结论
  --refresh  重新获取并验证已签名的中继列表
  --singbox  按该列表打印（或写出）一份 sing-box 配置`,
  },

  'routes.refreshOk': {
    en: 'signed relay list v{version} verified and cached',
    ru: 'подписанный список релеев v{version} проверен и сохранён',
    es: 'lista firmada de reles v{version} verificada y guardada',
    pt: 'lista assinada de reles v{version} verificada e guardada',
    tr: 'imzali role listesi v{version} dogrulandi ve saklandi',
    uk: 'підписаний список релеїв v{version} перевірено і збережено',
    'zh-Hans': '已签名的中继列表 v{version} 校验通过并已缓存',
  },
  'routes.refreshFail': {
    en: 'no source answered with a valid payload; keeping the list already held',
    ru: 'ни один источник не дал корректного списка; остаётся прежний',
    es: 'ninguna fuente dio un payload valido; se conserva la lista anterior',
    pt: 'nenhuma fonte deu um payload valido; a lista anterior fica',
    tr: 'hicbir kaynak gecerli bir yuk vermedi; onceki liste kaliyor',
    uk: 'жодне джерело не дало коректного списку; лишається попередній',
    'zh-Hans': '没有来源给出有效的配置，继续沿用已有的列表',
  },
  'routes.badPort': {
    en: '--port takes a port number from 1 to 65535',
    ru: '--port принимает номер порта от 1 до 65535',
    es: '--port toma un numero de puerto de 1 a 65535',
    pt: '--port aceita um numero de porta de 1 a 65535',
    tr: '--port 1 ile 65535 arasinda bir port numarasi alir',
    uk: '--port приймає номер порту від 1 до 65535',
    'zh-Hans': '--port 需要一个 1 到 65535 之间的端口号',
  },

  'routes.shapeOnion': {
    en: 'two hops, entry {entry} pinned; sing-box builds the chain',
    ru: 'два прыжка, вход {entry} закреплён; цепочку строит sing-box',
    es: 'dos saltos, entrada {entry} fijada; la cadena la arma sing-box',
    pt: 'dois saltos, entrada {entry} fixada; a cadeia e montada pelo sing-box',
    tr: 'iki siçrama, giris {entry} sabit; zinciri sing-box kurar',
    uk: 'два стрибки, вхід {entry} закріплено; ланцюг будує sing-box',
    'zh-Hans': '两跳，入口 {entry} 已固定；链路由 sing-box 搭建',
  },
  'routes.shapeOnionDegraded': {
    en: 'onion is on but the chain cannot form; one hop over the signed relays only',
    ru: 'лук включён, но цепочка не складывается; один прыжок только по подписанным релеям',
    es: 'onion esta activo pero la cadena no se forma; un salto solo por los reles firmados',
    pt: 'onion esta ligado mas a cadeia nao se forma; um salto so pelos reles assinados',
    tr: 'onion acik ama zincir kurulamiyor; yalnizca imzali roleler uzerinden tek siçrama',
    uk: 'цибуля увімкнена, але ланцюг не складається; один стрибок лише по підписаних релеях',
    'zh-Hans': '洋葱模式已开启但链路无法成形；只在已签名的中继上单跳',
  },
  'routes.shapeSingleHop': {
    en: 'one hop, the fastest relay wins',
    ru: 'один прыжок, побеждает самый быстрый релей',
    es: 'un salto, gana el rele mas rapido',
    pt: 'um salto, vence o rele mais rapido',
    tr: 'tek siçrama, en hizli role kazanir',
    uk: 'один стрибок, перемагає найшвидший релей',
    'zh-Hans': '单跳，最快的中继胜出',
  },
  'routes.entryUnprobed': {
    en: 'the entry was chosen without probing: your proxy is engaged, and a probe is a raw socket that would have gone around it',
    ru: 'вход выбран без пробы: включён ваш прокси, а проба это сырой сокет, который пошёл бы мимо него',
    es: 'la entrada se eligió sin sondear: tu proxy está activo, y la sonda es un socket crudo que lo habría esquivado',
    pt: 'a entrada foi escolhida sem sondagem: seu proxy está ativo, e a sonda é um socket cru que passaria por fora dele',
    tr: 'giriş sinama yapılmadan seçildi: proxy devrede ve sinama, onun etrafından dolaşacak ham bir soket',
    uk: 'вхід обрано без проби: увімкнено ваш проксі, а проба це сирий сокет, який пішов би повз нього',
    'zh-Hans': '入口是在没有探测的情况下选定的: 你的代理已生效, 而探测用的是会绕过它的原始套接字',
  },
  'routes.relayCounts': {
    en: '{trusted} from the signed list, {community} from the broker (fallback only, never an entry)',
    ru: '{trusted} из подписанного списка, {community} от брокера (только запас, никогда не вход)',
    es: '{trusted} de la lista firmada, {community} del broker (solo reserva, nunca entrada)',
    pt: '{trusted} da lista assinada, {community} do broker (so reserva, nunca entrada)',
    tr: 'imzali listeden {trusted}, brokerdan {community} (yalnizca yedek, asla giris degil)',
    uk: '{trusted} з підписаного списку, {community} від брокера (лише запас, ніколи не вхід)',
    'zh-Hans': '{trusted} 个来自已签名列表，{community} 个来自 broker（仅作后备，绝不做入口）',
  },
  'routes.noBridges': {
    en: 'the broker handed out nothing: it rations per network, and it may be blocked here too',
    ru: 'брокер ничего не выдал: он делит пул по сетям, и его самого могли перекрыть',
    es: 'el broker no dio nada: raciona por red, y aqui tambien puede estar bloqueado',
    pt: 'o broker nao deu nada: ele raciona por rede, e aqui tambem pode estar bloqueado',
    tr: 'broker bir sey vermedi: havuzu aglara bolusturur ve burada o da engelli olabilir',
    uk: 'брокер нічого не видав: він ділить пул за мережами, і його самого могли перекрити',
    'zh-Hans': 'broker 没有给出任何中继：它按网络配额发放，而且在这里也可能被封',
  },
  'routes.singboxHowto': {
    en: `then, with a sing-box of your own:
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
    ru: `дальше, со своим sing-box:
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
    es: `luego, con tu propio sing-box:
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
    pt: `depois, com um sing-box seu:
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
    tr: `sonra, kendi sing-box'iniz ile:
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
    uk: `далі, зі своїм sing-box:
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
    'zh-Hans': `随后，用你自己的 sing-box：
  sing-box run -c {file}
  rcq proxy set socks5://127.0.0.1:{port}`,
  },

  'phrase.keep': {
    en:
      '\nKEEP THIS PHRASE. It recreates the account on any device, forever.\n' +
      'Anyone who has it IS this account. It is stored in the state dir:\n' +
      'delete it there after writing it down if this box is not trusted.\n',
    ru:
      '\nСОХРАНИТЕ ЭТУ ФРАЗУ. Она навсегда восстанавливает аккаунт на любом устройстве.\n' +
      'Кто знает фразу, тот и есть этот аккаунт. Копия лежит в каталоге состояния:\n' +
      'запишите фразу и удалите копию, если этой машине нет полного доверия.\n',
    es:
      '\nGUARDÁ ESTA FRASE. Recrea la cuenta en cualquier dispositivo, para siempre.\n' +
      'Quien la tenga ES esta cuenta. Se guarda en el directorio de estado:\n' +
      'borrala de ahí tras anotarla si esta máquina no es de confianza.\n',
    pt:
      '\nGUARDE ESTA FRASE. Ela recria a conta em qualquer dispositivo, para sempre.\n' +
      'Quem a tiver É esta conta. Ela fica no diretório de estado:\n' +
      'apague de lá depois de anotá-la se esta máquina não for confiável.\n',
    tr:
      '\nBU İFADEYİ SAKLA. Hesabı her cihazda, sonsuza dek yeniden oluşturur.\n' +
      'Ona sahip olan bu hesabın TA KENDİSİDİR. Durum dizininde tutulur:\n' +
      'bu makineye tam güven yoksa yazdıktan sonra oradan sil.\n',
    uk:
      '\nЗБЕРЕЖІТЬ ЦЮ ФРАЗУ. Вона назавжди відновлює акаунт на будь-якому пристрої.\n' +
      'Хто знає фразу, той і є цей акаунт. Копія лежить у каталозі стану:\n' +
      'запишіть фразу і видаліть копію, якщо цій машині немає повної довіри.\n',
    'zh-Hans':
      '\n请保管好这条短语。它可以在任何设备上永久重建账号。\n' +
      '谁持有它, 谁就是这个账号。它保存在状态目录里:\n' +
      '如果这台机器不可信, 抄下后请把它从那里删除。\n',
  },

  'restore.needsPhrase': {
    en: 'restore needs the quoted 24-word phrase',
    ru: 'restore ждёт фразу из 24 слов в кавычках',
    es: 'restore necesita la frase de 24 palabras entre comillas',
    pt: 'restore precisa da frase de 24 palavras entre aspas',
    tr: 'restore tırnak içinde 24 kelimelik ifadeyi ister',
    uk: 'restore чекає фразу з 24 слів у лапках',
    'zh-Hans': 'restore 需要带引号的 24 个词的短语',
  },
  'restore.done': {
    en: 'restored. The libsignal device registers on the first send/watch.',
    ru: 'восстановлено. Устройство libsignal зарегистрируется при первом send или watch.',
    es: 'restaurado. El dispositivo libsignal se registra en el primer send/watch.',
    pt: 'restaurado. O dispositivo libsignal se registra no primeiro send/watch.',
    tr: 'geri getirildi. libsignal cihazı ilk send/watch ile kaydolur.',
    uk: 'відновлено. Пристрій libsignal зареєструється при першому send або watch.',
    'zh-Hans': '已恢复。libsignal 设备会在首次 send/watch 时注册。',
  },

  'nick.needsName': {
    en: 'nick needs the new name in quotes',
    ru: 'nick ждёт новое имя в кавычках',
    es: 'nick necesita el nuevo nombre entre comillas',
    pt: 'nick precisa do novo nome entre aspas',
    tr: 'nick yeni adı tırnak içinde ister',
    uk: 'nick чекає нове імʼя в лапках',
    'zh-Hans': 'nick 需要带引号的新名字',
  },
  'nick.done': {
    en: 'you are now "{name}"',
    ru: 'теперь вы "{name}"',
    es: 'ahora sos "{name}"',
    pt: 'agora você é "{name}"',
    tr: 'artık "{name}" oldun',
    uk: 'тепер ви "{name}"',
    'zh-Hans': '你现在是 "{name}"',
  },

  'add.needsUin': {
    en: 'add needs a numeric UIN',
    ru: 'add ждёт числовой UIN',
    es: 'add necesita un UIN numérico',
    pt: 'add precisa de um UIN numérico',
    tr: 'add sayısal bir UIN ister',
    uk: 'add чекає числовий UIN',
    'zh-Hans': 'add 需要一个数字 UIN',
  },
  'add.sent': {
    en: 'contact request sent to {who}',
    ru: 'заявка в контакты отправлена {who}',
    es: 'solicitud de contacto enviada a {who}',
    pt: 'pedido de contato enviado para {who}',
    tr: '{who} kişisine kişi isteği gönderildi',
    uk: 'запит у контакти надіслано {who}',
    'zh-Hans': '联系人请求已发送给 {who}',
  },
  // The island auto-accepts when they had already asked for us. Saying "sent"
  // there hid the one case where adding simply worked.
  'add.mutual': {
    en: '{who} had already asked for you, so you are contacts now',
    ru: '{who} уже отправлял вам заявку, теперь вы контакты',
    es: '{who} ya te había pedido, así que ahora son contactos',
    pt: '{who} já tinha pedido, então agora vocês são contatos',
    tr: '{who} zaten seni istemişti, artık kişisiniz',
    uk: '{who} вже надсилав вам запит, тепер ви контакти',
    'zh-Hans': '{who} 之前已经请求过你, 现在你们是联系人了',
  },
  'add.already': {
    en: '{who} is already in your contacts',
    ru: '{who} уже в ваших контактах',
    es: '{who} ya está en tus contactos',
    pt: '{who} já está nos seus contatos',
    tr: '{who} zaten kişilerinde',
    uk: '{who} вже у ваших контактах',
    'zh-Hans': '{who} 已经在你的联系人里',
  },

  // Contact requests: the half the console could never answer.
  'req.none': {
    en: 'no contact requests',
    ru: 'заявок в контакты нет',
    es: 'no hay solicitudes de contacto',
    pt: 'nenhum pedido de contato',
    tr: 'kişi isteği yok',
    uk: 'запитів у контакти немає',
    'zh-Hans': '没有联系人请求',
  },
  'req.noneFrom': {
    en: 'there is no request from {who}',
    ru: 'от {who} нет заявки',
    es: 'no hay solicitud de {who}',
    pt: 'não há pedido de {who}',
    tr: '{who} kişisinden istek yok',
    uk: 'від {who} немає запиту',
    'zh-Hans': '没有来自 {who} 的请求',
  },
  'req.waiting': {
    en: '{n} contact request(s) waiting - see "rcq requests"',
    ru: 'ждут ответа заявок: {n}, показать: "rcq requests"',
    es: '{n} solicitud(es) de contacto esperando, mirá "rcq requests"',
    pt: '{n} pedido(s) de contato esperando, veja "rcq requests"',
    tr: '{n} kişi isteği bekliyor, bak "rcq requests"',
    uk: 'чекають запитів: {n}, показати: "rcq requests"',
    'zh-Hans': '有 {n} 条联系人请求在等待, 见 "rcq requests"',
  },
  'req.answerHint': {
    en: 'wants to add you: /accept {uin} or /decline {uin}',
    ru: 'хочет добавить вас: /accept {uin} или /decline {uin}',
    es: 'quiere agregarte: /accept {uin} o /decline {uin}',
    pt: 'quer te adicionar: /accept {uin} ou /decline {uin}',
    tr: 'seni eklemek istiyor: /accept {uin} veya /decline {uin}',
    uk: 'хоче додати вас: /accept {uin} або /decline {uin}',
    'zh-Hans': '想加你: /accept {uin} 或 /decline {uin}',
  },
  'req.statePending': {
    en: 'waiting for their answer',
    ru: 'ждём их ответа',
    es: 'esperando su respuesta',
    pt: 'esperando a resposta',
    tr: 'yanıtı bekleniyor',
    uk: 'чекаємо їхньої відповіді',
    'zh-Hans': '等待对方回应',
  },
  'req.stateDeclined': {
    en: 'declined',
    ru: 'отклонено',
    es: 'rechazada',
    pt: 'recusado',
    tr: 'reddedildi',
    uk: 'відхилено',
    'zh-Hans': '已拒绝',
  },
  'req.incoming': {
    en: '{who} wants to add you: /accept {uin} or /decline {uin}',
    ru: '{who} хочет добавить вас: /accept {uin} или /decline {uin}',
    es: '{who} quiere agregarte: /accept {uin} o /decline {uin}',
    pt: '{who} quer te adicionar: /accept {uin} ou /decline {uin}',
    tr: '{who} seni eklemek istiyor: /accept {uin} veya /decline {uin}',
    uk: '{who} хоче додати вас: /accept {uin} або /decline {uin}',
    'zh-Hans': '{who} 想加你: /accept {uin} 或 /decline {uin}',
  },
  'req.accepted': {
    en: '{who} accepted your contact request',
    ru: '{who} принял вашу заявку',
    es: '{who} aceptó tu solicitud de contacto',
    pt: '{who} aceitou seu pedido de contato',
    tr: '{who} kişi isteğini kabul etti',
    uk: '{who} прийняв ваш запит',
    'zh-Hans': '{who} 接受了你的联系人请求',
  },
  'req.declined': {
    en: '{who} declined your contact request',
    ru: '{who} отклонил вашу заявку',
    es: '{who} rechazó tu solicitud de contacto',
    pt: '{who} recusou seu pedido de contato',
    tr: '{who} kişi isteğini reddetti',
    uk: '{who} відхилив ваш запит',
    'zh-Hans': '{who} 拒绝了你的联系人请求',
  },
  'req.withdrawn': {
    en: '{who} withdrew their contact request',
    ru: '{who} отозвал свою заявку',
    es: '{who} retiró su solicitud de contacto',
    pt: '{who} retirou o pedido de contato',
    tr: '{who} kişi isteğini geri çekti',
    uk: '{who} відкликав свій запит',
    'zh-Hans': '{who} 撤回了联系人请求',
  },
  'req.youAccepted': {
    en: '{who} is now in your contacts',
    ru: '{who} теперь в ваших контактах',
    es: '{who} ahora está en tus contactos',
    pt: '{who} agora está nos seus contatos',
    tr: '{who} artık kişilerinde',
    uk: '{who} тепер у ваших контактах',
    'zh-Hans': '{who} 现在在你的联系人里',
  },
  'req.youDeclined': {
    en: 'declined the request from {who}',
    ru: 'заявка от {who} отклонена',
    es: 'rechazaste la solicitud de {who}',
    pt: 'pedido de {who} recusado',
    tr: '{who} kişisinin isteği reddedildi',
    uk: 'запит від {who} відхилено',
    'zh-Hans': '已拒绝来自 {who} 的请求',
  },
  'req.cancelled': {
    en: 'your request to {who} is withdrawn',
    ru: 'ваша заявка к {who} отозвана',
    es: 'tu solicitud a {who} fue retirada',
    pt: 'seu pedido a {who} foi retirado',
    tr: '{who} kişisine isteğin geri çekildi',
    uk: 'ваш запит до {who} відкликано',
    'zh-Hans': '你发给 {who} 的请求已撤回',
  },
  'accept.needsUin': {
    en: 'accept needs a numeric UIN',
    ru: 'accept ждёт числовой UIN',
    es: 'accept necesita un UIN numérico',
    pt: 'accept precisa de um UIN numérico',
    tr: 'accept sayısal bir UIN ister',
    uk: 'accept чекає числовий UIN',
    'zh-Hans': 'accept 需要一个数字 UIN',
  },
  'decline.needsUin': {
    en: 'decline needs a numeric UIN',
    ru: 'decline ждёт числовой UIN',
    es: 'decline necesita un UIN numérico',
    pt: 'decline precisa de um UIN numérico',
    tr: 'decline sayısal bir UIN ister',
    uk: 'decline чекає числовий UIN',
    'zh-Hans': 'decline 需要一个数字 UIN',
  },
  'cancel.needsUin': {
    en: 'cancel needs a numeric UIN',
    ru: 'cancel ждёт числовой UIN',
    es: 'cancel necesita un UIN numérico',
    pt: 'cancel precisa de um UIN numérico',
    tr: 'cancel sayısal bir UIN ister',
    uk: 'cancel чекає числовий UIN',
    'zh-Hans': 'cancel 需要一个数字 UIN',
  },

  'find.needsQuery': {
    en: 'find needs a name in quotes',
    ru: 'find ждёт имя в кавычках',
    es: 'find necesita un nombre entre comillas',
    pt: 'find precisa de um nome entre aspas',
    tr: 'find tırnak içinde bir ad ister',
    uk: 'find чекає імʼя в лапках',
    'zh-Hans': 'find 需要带引号的名字',
  },
  'find.none': {
    en: 'nobody on this island matches "{q}"',
    ru: 'на этом острове никто не подходит под "{q}"',
    es: 'nadie en esta isla coincide con "{q}"',
    pt: 'ninguém nesta ilha corresponde a "{q}"',
    tr: 'bu adada "{q}" ile eşleşen kimse yok',
    uk: 'на цьому острові ніхто не підходить під "{q}"',
    'zh-Hans': '此服务器上没有匹配 "{q}" 的人',
  },

  'block.needsUin': {
    en: 'block needs a numeric UIN',
    ru: 'block ждёт числовой UIN',
    es: 'block necesita un UIN numérico',
    pt: 'block precisa de um UIN numérico',
    tr: 'block sayısal bir UIN ister',
    uk: 'block чекає числовий UIN',
    'zh-Hans': 'block 需要一个数字 UIN',
  },
  'block.done': {
    en: '{who} is blocked',
    ru: '{who} заблокирован',
    es: '{who} está bloqueado',
    pt: '{who} está bloqueado',
    tr: '{who} engellendi',
    uk: '{who} заблокований',
    'zh-Hans': '{who} 已被屏蔽',
  },
  'block.undone': {
    en: '{who} is unblocked',
    ru: '{who} разблокирован',
    es: '{who} está desbloqueado',
    pt: '{who} está desbloqueado',
    tr: '{who} engeli kaldırıldı',
    uk: '{who} розблокований',
    'zh-Hans': '{who} 已解除屏蔽',
  },
  'remove.needsUin': {
    en: 'remove needs a numeric UIN',
    ru: 'remove ждёт числовой UIN',
    es: 'remove necesita un UIN numérico',
    pt: 'remove precisa de um UIN numérico',
    tr: 'remove sayısal bir UIN ister',
    uk: 'remove чекає числовий UIN',
    'zh-Hans': 'remove 需要一个数字 UIN',
  },
  'remove.confirm': {
    en: 'remove {who} from your contacts, on both sides? [y/N] ',
    ru: 'удалить {who} из контактов у обоих? [y/N] ',
    es: 'quitar a {who} de tus contactos, en ambos lados? [y/N] ',
    pt: 'remover {who} dos seus contatos, dos dois lados? [y/N] ',
    tr: '{who} kişisi iki taraftan da silinsin mi? [y/N] ',
    uk: 'видалити {who} з контактів у обох? [y/N] ',
    'zh-Hans': '双向从你的联系人中删除 {who}? [y/N] ',
  },
  'remove.needsYes': {
    en: 'not removed: {who} would go from both contact lists. Add --yes to do it',
    ru: 'не удалено: {who} исчезнет из списков у обоих. Добавьте --yes, чтобы удалить',
    es: 'no se quitó: {who} saldría de ambas listas. Agregá --yes para hacerlo',
    pt: 'não removido: {who} sairia das duas listas. Adicione --yes para fazer isso',
    tr: 'silinmedi: {who} iki listeden de çıkardı. Yapmak için --yes ekle',
    uk: 'не видалено: {who} зникне зі списків у обох. Додайте --yes, щоб видалити',
    'zh-Hans': '未删除: {who} 会从双方列表中消失。加 --yes 才会执行',
  },
  'remove.cancelled': {
    en: 'nothing removed',
    ru: 'ничего не удалено',
    es: 'no se quitó nada',
    pt: 'nada removido',
    tr: 'hiçbir şey silinmedi',
    uk: 'нічого не видалено',
    'zh-Hans': '没有删除任何内容',
  },
  'remove.done': {
    en: '{who} is no longer in your contacts',
    ru: '{who} больше не в ваших контактах',
    es: '{who} ya no está en tus contactos',
    pt: '{who} não está mais nos seus contatos',
    tr: '{who} artık kişilerinde değil',
    uk: '{who} більше не у ваших контактах',
    'zh-Hans': '{who} 已不在你的联系人里',
  },

  // Names, and how much of a stranger somebody is. The label itself ("Ivan
  // (#396)") is DATA and never passes through here; these are the words around
  // it.
  'dir.stale': {
    en: 'names may be out of date, the roster did not load: {err}',
    ru: 'имена могут быть устаревшими, список не загрузился: {err}',
    es: 'los nombres pueden estar desactualizados, la lista no cargó: {err}',
    pt: 'os nomes podem estar desatualizados, a lista não carregou: {err}',
    tr: 'adlar güncel olmayabilir, liste yüklenmedi: {err}',
    uk: 'імена можуть бути застарілими, список не завантажився: {err}',
    'zh-Hans': '名字可能已过时, 名册未加载: {err}',
  },

  'who.needsUin': {
    en: 'who needs a numeric UIN',
    ru: 'who ждёт числовой UIN',
    es: 'who necesita un UIN numérico',
    pt: 'who precisa de um UIN numérico',
    tr: 'who sayısal bir UIN ister',
    uk: 'who чекає числовий UIN',
    'zh-Hans': 'who 需要一个数字 UIN',
  },
  'who.contact': {
    en: 'in your contacts',
    ru: 'в ваших контактах',
    es: 'en tus contactos',
    pt: 'nos seus contatos',
    tr: 'kişilerinde',
    uk: 'у ваших контактах',
    'zh-Hans': '在你的联系人里',
  },
  'who.stranger': {
    en: 'not in your contacts',
    ru: 'не в ваших контактах',
    es: 'no está en tus contactos',
    pt: 'não está nos seus contatos',
    tr: 'kişilerinde değil',
    uk: 'не у ваших контактах',
    'zh-Hans': '不在你的联系人里',
  },
  'who.thread': {
    en: 'you have exchanged messages before',
    ru: 'вы уже переписывались',
    es: 'ya intercambiaron mensajes antes',
    pt: 'vocês já trocaram mensagens antes',
    tr: 'daha önce mesajlaştınız',
    uk: 'ви вже листувалися',
    'zh-Hans': '你们之前有过消息往来',
  },
  'who.noThread': {
    en: 'you have never exchanged a message',
    ru: 'вы ещё ни разу не переписывались',
    es: 'nunca intercambiaron un mensaje',
    pt: 'vocês nunca trocaram uma mensagem',
    tr: 'hiç mesajlaşmadınız',
    uk: 'ви ще жодного разу не листувалися',
    'zh-Hans': '你们从未有过消息往来',
  },
  'who.unreachable': {
    en: 'could not ask the island who #{uin} is',
    ru: 'не удалось спросить остров, кто такой #{uin}',
    es: 'no se pudo preguntar a la isla quién es #{uin}',
    pt: 'não foi possível perguntar à ilha quem é #{uin}',
    tr: '#{uin} kim, adaya sorulamadı',
    uk: 'не вдалося спитати острів, хто такий #{uin}',
    'zh-Hans': '无法向服务器询问 #{uin} 是谁',
  },

  // The gate on the FIRST message of a thread. The mailbox stays open (anyone
  // may write first); what ends here is doing it by accident.
  'stranger.cold': {
    en: '{who} is not in your contacts, and you have never written to them',
    ru: '{who} не в ваших контактах, и вы им ещё не писали',
    es: '{who} no está en tus contactos, y nunca le escribiste',
    pt: '{who} não está nos seus contatos, e você nunca escreveu para ele',
    tr: '{who} kişilerinde değil ve ona hiç yazmadın',
    uk: '{who} не у ваших контактах, і ви їм ще не писали',
    'zh-Hans': '{who} 不在你的联系人里, 你也从未给对方写过',
  },
  'stranger.missing': {
    en: 'there is no account #{uin} on this island (a typo?)',
    ru: 'на этом острове нет аккаунта #{uin} (опечатка?)',
    es: 'no existe la cuenta #{uin} en esta isla (un error de tipeo?)',
    pt: 'não existe a conta #{uin} nesta ilha (erro de digitação?)',
    tr: 'bu adada #{uin} hesabı yok (yazım hatası mı?)',
    uk: 'на цьому острові немає акаунта #{uin} (одрук?)',
    'zh-Hans': '此服务器上没有账号 #{uin} (打错了?)',
  },
  'stranger.unverified': {
    en: 'and the island did not answer who they are',
    ru: 'и остров не ответил, кто это',
    es: 'y la isla no respondió quién es',
    pt: 'e a ilha não respondeu quem é',
    tr: 've ada bunun kim olduğunu yanıtlamadı',
    uk: 'і острів не відповів, хто це',
    'zh-Hans': '而且服务器没有回答对方是谁',
  },
  'stranger.reveals': {
    en: 'a message tells them this account exists',
    ru: 'сообщение скажет им, что этот аккаунт существует',
    es: 'un mensaje les dice que esta cuenta existe',
    pt: 'uma mensagem diz a eles que esta conta existe',
    tr: 'bir mesaj onlara bu hesabın var olduğunu söyler',
    uk: 'повідомлення скаже їм, що цей акаунт існує',
    'zh-Hans': '一条消息会告诉对方这个账号存在',
  },
  'stranger.confirm': {
    en: 'send to {who} anyway? [y/N] ',
    ru: 'всё равно отправить {who}? [y/N] ',
    es: 'enviar a {who} de todos modos? [y/N] ',
    pt: 'enviar para {who} mesmo assim? [y/N] ',
    tr: 'yine de {who} kişisine gönderilsin mi? [y/N] ',
    uk: 'усе одно надіслати {who}? [y/N] ',
    'zh-Hans': '仍然发送给 {who}? [y/N] ',
  },
  'stranger.cancelled': {
    en: 'not sent',
    ru: 'не отправлено',
    es: 'no enviado',
    pt: 'não enviado',
    tr: 'gönderilmedi',
    uk: 'не надіслано',
    'zh-Hans': '未发送',
  },
  'stranger.needsYes': {
    en: 'not sent: {who} is not in your contacts. Add --yes to send anyway',
    ru: 'не отправлено: {who} не в ваших контактах. Добавьте --yes, чтобы всё равно отправить',
    es: 'no enviado: {who} no está en tus contactos. Agregá --yes para enviar igual',
    pt: 'não enviado: {who} não está nos seus contatos. Adicione --yes para enviar mesmo assim',
    tr: 'gönderilmedi: {who} kişilerinde değil. Yine de göndermek için --yes ekle',
    uk: 'не надіслано: {who} не у ваших контактах. Додайте --yes, щоб усе одно надіслати',
    'zh-Hans': '未发送: {who} 不在你的联系人里。加 --yes 才会照样发送',
  },
  'stranger.willAsk': {
    en: 'nothing is sent yet: the first message asks first',
    ru: 'пока ничего не отправлено: перед первым сообщением спросим',
    es: 'todavía no se envió nada: el primer mensaje pregunta antes',
    pt: 'nada foi enviado ainda: a primeira mensagem pergunta antes',
    tr: 'henüz bir şey gönderilmedi: ilk mesajdan önce sorulur',
    uk: 'поки нічого не надіслано: перед першим повідомленням спитаємо',
    'zh-Hans': '还什么都没发: 第一条消息之前会先询问',
  },
  'inbound.stranger': {
    en: '{who} is not in your contacts',
    ru: '{who} не в ваших контактах',
    es: '{who} no está en tus contactos',
    pt: '{who} não está nos seus contatos',
    tr: '{who} kişilerinde değil',
    uk: '{who} не у ваших контактах',
    'zh-Hans': '{who} 不在你的联系人里',
  },

  // Things that used to fail without a word.
  'fail.carbon': {
    en: 'this message will not appear on your other devices: {err}',
    ru: 'это сообщение не появится на других ваших устройствах: {err}',
    es: 'este mensaje no aparecerá en tus otros dispositivos: {err}',
    pt: 'esta mensagem não vai aparecer nos seus outros dispositivos: {err}',
    tr: 'bu mesaj diğer cihazlarında görünmeyecek: {err}',
    uk: 'це повідомлення не зʼявиться на інших ваших пристроях: {err}',
    'zh-Hans': '这条消息不会出现在你的其他设备上: {err}',
  },
  'fail.receipt': {
    en: 'delivery receipts are not going out, the sender keeps one tick',
    ru: 'квитанции о доставке не уходят, у отправителя останется одна галочка',
    es: 'los acuses de entrega no salen, el remitente se queda con una tilde',
    pt: 'os recibos de entrega não estão saindo, o remetente fica com um tique',
    tr: 'iletim alındıları çıkmıyor, gönderende tek tik kalır',
    uk: 'квитанції про доставку не йдуть, у відправника лишиться одна галочка',
    'zh-Hans': '送达回执发不出去, 发送方只会有一个勾',
  },
  // The transport, in words. See errors.ts: these replace Node's raw
  // `fetch failed` wherever a failure reaches a person.
  'net.unreachable': {
    en: 'the island did not answer',
    ru: 'остров не ответил',
    es: 'la isla no respondió',
    pt: 'a ilha não respondeu',
    tr: 'ada yanıt vermedi',
    uk: 'острів не відповів',
    'zh-Hans': '服务器没有响应',
  },
  'net.timeout': {
    en: 'the island did not answer in time',
    ru: 'остров не ответил вовремя',
    es: 'la isla no respondió a tiempo',
    pt: 'a ilha não respondeu a tempo',
    tr: 'ada zamanında yanıt vermedi',
    uk: 'острів не відповів вчасно',
    'zh-Hans': '服务器没有及时响应',
  },
  'net.noHost': {
    en: 'no such island (the address did not resolve)',
    ru: 'такого острова нет (адрес не разрешился)',
    es: 'no existe esa isla (la dirección no resolvió)',
    pt: 'ilha inexistente (o endereço não resolveu)',
    tr: 'böyle bir ada yok (adres çözümlenmedi)',
    uk: 'такого острова немає (адреса не розвʼязалася)',
    'zh-Hans': '没有这个服务器 (地址无法解析)',
  },

  'fail.live': {
    en: 'a live message could not be opened ({err}); the next queue read retries it',
    ru: 'живое сообщение не удалось открыть ({err}); повтор при следующем чтении очереди',
    es: 'no se pudo abrir un mensaje en vivo ({err}); la próxima lectura de cola lo reintenta',
    pt: 'não foi possível abrir uma mensagem ao vivo ({err}); a próxima leitura da fila tenta de novo',
    tr: 'canlı bir mesaj açılamadı ({err}); sıradaki kuyruk okuması yeniden dener',
    uk: 'живе повідомлення не вдалося відкрити ({err}); повтор при наступному читанні черги',
    'zh-Hans': '一条实时消息无法打开 ({err}); 下次读取队列会重试',
  },
  'fail.contacts': {
    en: 'showing the last known list, the island did not answer: {err}',
    ru: 'показан последний известный список, остров не ответил: {err}',
    es: 'mostrando la última lista conocida, la isla no respondió: {err}',
    pt: 'mostrando a última lista conhecida, a ilha não respondeu: {err}',
    tr: 'bilinen son liste gösteriliyor, ada yanıt vermedi: {err}',
    uk: 'показано останній відомий список, острів не відповів: {err}',
    'zh-Hans': '显示上次已知的列表, 服务器没有响应: {err}',
  },
  'fail.command': {
    en: '{cmd} failed: {err}',
    ru: '{cmd} не выполнено: {err}',
    es: '{cmd} falló: {err}',
    pt: '{cmd} falhou: {err}',
    tr: '{cmd} başarısız: {err}',
    uk: '{cmd} не виконано: {err}',
    'zh-Hans': '{cmd} 失败: {err}',
  },

  'send.needsArgs': {
    en: 'send needs <uin> and "text"',
    ru: 'send ждёт <uin> и "текст"',
    es: 'send necesita <uin> y "texto"',
    pt: 'send precisa de <uin> e "texto"',
    tr: 'send <uin> ve "metin" ister',
    uk: 'send чекає <uin> і "текст"',
    'zh-Hans': 'send 需要 <uin> 和 "文本"',
  },
  'send.failed': {
    en: 'send failed: {err}',
    ru: 'отправка не удалась: {err}',
    es: 'el envío falló: {err}',
    pt: 'o envio falhou: {err}',
    tr: 'gönderim başarısız: {err}',
    uk: 'надсилання не вдалося: {err}',
    'zh-Hans': '发送失败: {err}',
  },
  'send.kept': {
    en: 'not sent, your text: {text}',
    ru: 'не отправлено, ваш текст: {text}',
    es: 'no enviado, tu texto: {text}',
    pt: 'não enviado, seu texto: {text}',
    tr: 'gönderilmedi, metnin: {text}',
    uk: 'не надіслано, ваш текст: {text}',
    'zh-Hans': '未发送, 你的文本: {text}',
  },
  // A line typed while the one before it is still on the wire. Sends are
  // strictly one at a time, so without this the text simply vanished off the
  // input row and nothing appeared until the one ahead of it finished.
  'send.queued': {
    en: '… waiting for the line before it: {text}',
    ru: '… ждёт предыдущую строку: {text}',
    es: '… esperando la línea anterior: {text}',
    pt: '… esperando a linha anterior: {text}',
    tr: '… önceki satırı bekliyor: {text}',
    uk: '… чекає попередній рядок: {text}',
    'zh-Hans': '… 正在等前一行: {text}',
  },
  // The interactive loop echoes the line before it sends it, so the text is
  // already on screen: what this adds is that it did NOT go, and that it is
  // still here.
  'send.failedTo': {
    en: '✗ not sent to {who}: {err}',
    ru: '✗ не отправлено {who}: {err}',
    es: '✗ no enviado a {who}: {err}',
    pt: '✗ não enviado para {who}: {err}',
    tr: '✗ {who} kişisine gönderilmedi: {err}',
    uk: '✗ не надіслано {who}: {err}',
    'zh-Hans': '✗ 未发送给 {who}: {err}',
  },
  'send.retryHint': {
    en: '  the text is kept - /retry sends it again',
    ru: '  текст сохранён, повторить: /retry',
    es: '  el texto se guarda, /retry lo envía de nuevo',
    pt: '  o texto foi guardado, /retry envia de novo',
    tr: '  metin saklandı, /retry tekrar gönderir',
    uk: '  текст збережено, повторити: /retry',
    'zh-Hans': '  文本已保留, /retry 再发一次',
  },
  'retry.nothing': {
    en: 'nothing to retry',
    ru: 'повторять нечего',
    es: 'nada para reintentar',
    pt: 'nada para tentar de novo',
    tr: 'yeniden denenecek bir şey yok',
    uk: 'повторювати нічого',
    'zh-Hans': '没有可重试的内容',
  },
  'send.tip': {
    en: "tip: plain 'rcq' is the live conversation - incoming above, a prompt below",
    ru: "подсказка: просто 'rcq' открывает живой разговор, входящие сверху, строка ввода снизу",
    es: "consejo: 'rcq' a secas es la conversación en vivo, entrantes arriba, una línea abajo",
    pt: "dica: apenas 'rcq' é a conversa ao vivo, recebidos em cima, uma linha embaixo",
    tr: "ipucu: yalın 'rcq' canlı sohbettir, gelenler üstte, altta bir giriş satırı",
    uk: "підказка: просто 'rcq' відкриває живу розмову, вхідні згори, рядок вводу знизу",
    'zh-Hans': "提示: 直接 'rcq' 就是实时对话, 收信在上, 输入行在下",
  },
  'word.delivered': {
    en: 'delivered',
    ru: 'доставлено',
    es: 'entregado',
    pt: 'entregue',
    tr: 'iletildi',
    uk: 'доставлено',
    'zh-Hans': '已送达',
  },
  'word.sent': {
    en: 'sent',
    ru: 'отправлено',
    es: 'enviado',
    pt: 'enviado',
    tr: 'gönderildi',
    uk: 'надіслано',
    'zh-Hans': '已发送',
  },

  'provision.v1only': {
    en: 'provision failed ({err}) - v=1 only',
    ru: 'устройство не зарегистрировалось ({err}), только v=1',
    es: 'el aprovisionamiento falló ({err}), solo v=1',
    pt: 'o provisionamento falhou ({err}), apenas v=1',
    tr: 'sağlama başarısız ({err}), yalnızca v=1',
    uk: 'реєстрація пристрою не вдалася ({err}), лише v=1',
    'zh-Hans': '设备注册失败 ({err}), 仅 v=1',
  },
  'provision.v1receive': {
    en: 'provision failed ({err}) - v=1 receive only',
    ru: 'устройство не зарегистрировалось ({err}), приём только v=1',
    es: 'el aprovisionamiento falló ({err}), recepción solo v=1',
    pt: 'o provisionamento falhou ({err}), recepção apenas v=1',
    tr: 'sağlama başarısız ({err}), alım yalnızca v=1',
    uk: 'реєстрація пристрою не вдалася ({err}), прийом лише v=1',
    'zh-Hans': '设备注册失败 ({err}), 仅 v=1 收信',
  },

  // The connection, said once each way. The close codes are RCQ_VERBOSE: two
  // raw [ws] lines per redial used to run through the middle of a conversation
  // for as long as the network was flapping.
  'ws.down': {
    en: 'offline - reconnecting, and the queue is read every 30s meanwhile',
    ru: 'нет связи, переподключаемся; очередь читается каждые 30с',
    es: 'sin conexión, reconectando; mientras tanto la cola se lee cada 30s',
    pt: 'offline, reconectando; enquanto isso a fila é lida a cada 30s',
    tr: 'çevrimdışı, yeniden bağlanılıyor; bu arada kuyruk her 30sn okunuyor',
    uk: 'немає звʼязку, перепідключаємося; черга читається кожні 30с',
    'zh-Hans': '离线, 正在重连; 期间每 30 秒读取一次队列',
  },
  'ws.up': {
    en: 'back online',
    ru: 'связь восстановлена',
    es: 'de vuelta en línea',
    pt: 'de volta online',
    tr: 'yeniden çevrimiçi',
    uk: 'звʼязок відновлено',
    'zh-Hans': '已恢复在线',
  },

  'watch.hello': {
    en: 'watching as #{uin} (Ctrl+C to stop)',
    ru: 'слушаем как #{uin} (Ctrl+C, чтобы выйти)',
    es: 'escuchando como #{uin} (Ctrl+C para parar)',
    pt: 'observando como #{uin} (Ctrl+C para parar)',
    tr: '#{uin} olarak izleniyor (durdurmak için Ctrl+C)',
    uk: 'слухаємо як #{uin} (Ctrl+C, щоб вийти)',
    'zh-Hans': '正以 #{uin} 监听 (Ctrl+C 停止)',
  },
  'watch.readonly': {
    en: "(read-only - plain 'rcq' opens the conversation mode)",
    ru: "(только чтение, разговор открывает просто 'rcq')",
    es: "(solo lectura, 'rcq' a secas abre el modo conversación)",
    pt: "(somente leitura, apenas 'rcq' abre o modo conversa)",
    tr: "(salt okunur, yalın 'rcq' sohbet modunu açar)",
    uk: "(лише читання, розмову відкриває просто 'rcq')",
    'zh-Hans': "(只读, 直接 'rcq' 进入对话模式)",
  },
  'watch.readonlyTyped': {
    en: "watch is read-only - Ctrl+C, then plain 'rcq' to talk",
    ru: "watch только читает: Ctrl+C, затем просто 'rcq', чтобы говорить",
    es: "watch es solo lectura: Ctrl+C, luego 'rcq' a secas para hablar",
    pt: "watch é somente leitura: Ctrl+C, depois apenas 'rcq' para conversar",
    tr: "watch salt okunur: Ctrl+C, sonra konuşmak için yalın 'rcq'",
    uk: "watch лише читає: Ctrl+C, потім просто 'rcq', щоб говорити",
    'zh-Hans': "watch 是只读的: Ctrl+C, 然后直接 'rcq' 来对话",
  },
  bye: { en: 'bye', ru: 'пока', es: 'adiós', pt: 'tchau', tr: 'görüşürüz', uk: 'бувай', 'zh-Hans': '再见' },

  'drain.noDevice': {
    en: 'drain skipped: this install has no device id yet',
    ru: 'очередь пропущена: у этой установки ещё нет id устройства',
    es: 'cola omitida: esta instalación aún no tiene id de dispositivo',
    pt: 'fila ignorada: esta instalação ainda não tem id de dispositivo',
    tr: 'kuyruk atlandı: bu kurulumun henüz cihaz id yok',
    uk: 'чергу пропущено: у цієї встановки ще немає id пристрою',
    'zh-Hans': '跳过队列: 此安装还没有设备 id',
  },
  'drain.http': {
    en: 'drain failed: HTTP {status}',
    ru: 'очередь не забрана: HTTP {status}',
    es: 'la cola falló: HTTP {status}',
    pt: 'a fila falhou: HTTP {status}',
    tr: 'kuyruk alınamadı: HTTP {status}',
    uk: 'чергу не забрано: HTTP {status}',
    'zh-Hans': '取队列失败: HTTP {status}',
  },
  'drain.error': {
    en: 'drain failed: {err}',
    ru: 'очередь не забрана: {err}',
    es: 'la cola falló: {err}',
    pt: 'a fila falhou: {err}',
    tr: 'kuyruk alınamadı: {err}',
    uk: 'чергу не забрано: {err}',
    'zh-Hans': '取队列失败: {err}',
  },
  'drain.row': {
    en: 'queued message {id} could not be read ({err}); the island will send it again',
    ru: 'сообщение {id} из очереди не прочиталось ({err}); остров пришлёт его снова',
    es: 'el mensaje en cola {id} no se pudo leer ({err}); la isla lo enviará de nuevo',
    pt: 'a mensagem na fila {id} não pôde ser lida ({err}); a ilha vai enviá-la de novo',
    tr: 'kuyruktaki {id} mesajı okunamadı ({err}); ada onu tekrar gönderecek',
    uk: 'повідомлення {id} з черги не прочиталося ({err}); острів надішле його знову',
    'zh-Hans': '队列中的消息 {id} 无法读取 ({err}); 服务器会再次发送',
  },
  'drain.ackFailed': {
    en: 'the island was not told the queue was read: {err}',
    ru: 'острову не удалось сообщить, что очередь прочитана: {err}',
    es: 'no se le pudo avisar a la isla que la cola fue leída: {err}',
    pt: 'não foi possível avisar à ilha que a fila foi lida: {err}',
    tr: 'kuyruğun okunduğu adaya bildirilemedi: {err}',
    uk: 'острову не вдалося повідомити, що чергу прочитано: {err}',
    'zh-Hans': '未能告知服务器队列已读取: {err}',
  },
  // The room logs (Stage 5): the same two failures as the queue above, named
  // apart from it so a person can tell which of the two drains did not run.
  'drain.logHttp': {
    en: 'rooms not read: HTTP {status}',
    ru: 'группы не забраны: HTTP {status}',
    es: 'los grupos no se leyeron: HTTP {status}',
    pt: 'os grupos não foram lidos: HTTP {status}',
    tr: 'gruplar alınamadı: HTTP {status}',
    uk: 'групи не забрано: HTTP {status}',
    'zh-Hans': '群消息未读取: HTTP {status}',
  },
  'drain.logError': {
    en: 'rooms not read: {err}',
    ru: 'группы не забраны: {err}',
    es: 'los grupos no se leyeron: {err}',
    pt: 'os grupos não foram lidos: {err}',
    tr: 'gruplar alınamadı: {err}',
    uk: 'групи не забрано: {err}',
    'zh-Hans': '群消息未读取: {err}',
  },

  // Rooms. One is OPEN and prints; the rest keep a count and say so once a
  // minute, because thirty rooms on one screen is not a conversation.
  'group.label': { en: 'group {gid}', ru: 'группа {gid}', es: 'grupo {gid}', pt: 'grupo {gid}', tr: 'grup {gid}', uk: 'група {gid}', 'zh-Hans': '群 {gid}' },
  'group.unread': {
    en: '+{n} new, {how}',
    ru: 'новых: {n}, {how}',
    es: '+{n} nuevos, {how}',
    pt: '+{n} novos, {how}',
    tr: '+{n} yeni, {how}',
    uk: 'нових: {n}, {how}',
    'zh-Hans': '+{n} 条新消息, {how}',
  },
  'group.readInteractive': {
    en: '/g {gid} to read',
    ru: 'читать: /g {gid}',
    es: '/g {gid} para leer',
    pt: '/g {gid} para ler',
    tr: 'okumak için /g {gid}',
    uk: 'читати: /g {gid}',
    'zh-Hans': '/g {gid} 查看',
  },
  'group.readOneShot': {
    en: 'rcq log g{gid} to read',
    ru: 'читать: rcq log g{gid}',
    es: 'rcq log g{gid} para leer',
    pt: 'rcq log g{gid} para ler',
    tr: 'okumak için rcq log g{gid}',
    uk: 'читати: rcq log g{gid}',
    'zh-Hans': 'rcq log g{gid} 查看',
  },
  'group.unknown': {
    en: 'no room called "{what}" - /g lists them',
    ru: 'комнаты "{what}" нет, список по /g',
    es: 'no hay una sala llamada "{what}", /g las lista',
    pt: 'não há sala chamada "{what}", /g lista elas',
    tr: '"{what}" adında oda yok, /g listeler',
    uk: 'кімнати "{what}" немає, список за /g',
    'zh-Hans': '没有叫 "{what}" 的群, /g 列出全部',
  },
  'group.notMember': {
    en: 'you are not in a group with id {gid} - "rcq groups" lists yours',
    ru: 'вы не состоите в группе с id {gid}, ваши покажет "rcq groups"',
    es: 'no estás en un grupo con id {gid}, "rcq groups" lista los tuyos',
    pt: 'você não está em um grupo com id {gid}, "rcq groups" lista os seus',
    tr: 'id {gid} olan bir grupta değilsin, "rcq groups" seninkileri listeler',
    uk: 'ви не в групі з id {gid}, ваші покаже "rcq groups"',
    'zh-Hans': '你不在 id 为 {gid} 的群里, "rcq groups" 列出你的群',
  },
  'group.members': { en: '{n} members', ru: 'участников: {n}', es: '{n} miembros', pt: '{n} membros', tr: '{n} üye', uk: 'учасників: {n}', 'zh-Hans': '{n} 名成员' },
  'group.youOwn': { en: 'yours', ru: 'ваша', es: 'tuya', pt: 'sua', tr: 'senin', uk: 'ваша', 'zh-Hans': '你的' },
  'group.ruleOwnerOnly': {
    en: 'owner posts only',
    ru: 'пишет только владелец',
    es: 'solo publica el dueño',
    pt: 'só o dono publica',
    tr: 'yalnızca sahip yazar',
    uk: 'пише лише власник',
    'zh-Hans': '仅群主可发',
  },
  'group.ruleSlowmode': {
    en: 'slow mode {sec}s',
    ru: 'медленный режим {sec}с',
    es: 'modo lento {sec}s',
    pt: 'modo lento {sec}s',
    tr: 'yavaş mod {sec}sn',
    uk: 'повільний режим {sec}с',
    'zh-Hans': '慢速模式 {sec}秒',
  },
  'group.ruleNoLinks': { en: 'no links', ru: 'без ссылок', es: 'sin enlaces', pt: 'sem links', tr: 'bağlantı yok', uk: 'без посилань', 'zh-Hans': '禁止链接' },
  'group.ownerOnly': {
    en: 'this room is read-only: only its owner posts',
    ru: 'эта комната только для чтения: пишет только владелец',
    es: 'esta sala es de solo lectura: solo publica su dueño',
    pt: 'esta sala é somente leitura: só o dono publica',
    tr: 'bu oda salt okunur: yalnızca sahibi yazar',
    uk: 'ця кімната лише для читання: пише лише власник',
    'zh-Hans': '这个群是只读的: 只有群主可以发',
  },
  'group.noLinks': {
    en: 'links are not allowed in this room',
    ru: 'в этой комнате нельзя ссылки',
    es: 'no se permiten enlaces en esta sala',
    pt: 'links não são permitidos nesta sala',
    tr: 'bu odada bağlantıya izin yok',
    uk: 'у цій кімнаті не можна посилання',
    'zh-Hans': '这个群不允许发链接',
  },
  'group.slowmode': {
    en: 'slow mode: wait a little before the next message',
    ru: 'медленный режим: подождите перед следующим сообщением',
    es: 'modo lento: esperá un poco antes del próximo mensaje',
    pt: 'modo lento: espere um pouco antes da próxima mensagem',
    tr: 'yavaş mod: sonraki mesajdan önce biraz bekle',
    uk: 'повільний режим: зачекайте перед наступним повідомленням',
    'zh-Hans': '慢速模式: 下一条消息前请稍等',
  },
  'group.slowmodeWait': {
    en: 'slow mode: {sec}s to go',
    ru: 'медленный режим: осталось {sec}с',
    es: 'modo lento: faltan {sec}s',
    pt: 'modo lento: faltam {sec}s',
    tr: 'yavaş mod: {sec}sn kaldı',
    uk: 'повільний режим: лишилося {sec}с',
    'zh-Hans': '慢速模式: 还需 {sec}秒',
  },
  'group.gone': {
    en: 'this room is gone, or you are no longer in it',
    ru: 'этой комнаты нет, или вас в ней больше нет',
    es: 'esta sala ya no existe, o ya no estás en ella',
    pt: 'esta sala não existe mais, ou você não está mais nela',
    tr: 'bu oda yok olmuş ya da artık içinde değilsin',
    uk: 'цієї кімнати немає, або вас у ній більше немає',
    'zh-Hans': '这个群没了, 或者你已不在其中',
  },
  'group.rosterFailed': {
    en: 'nothing sent: who is in "{name}" could not be read, and a message has to be sealed to each of them ({err})',
    ru: 'ничего не отправлено: не удалось узнать, кто в "{name}", а сообщение шифруется каждому из них ({err})',
    es: 'no se envió nada: no se pudo leer quién está en "{name}", y el mensaje se cifra para cada uno ({err})',
    pt: 'nada enviado: não foi possível ler quem está em "{name}", e a mensagem é cifrada para cada um ({err})',
    tr: 'hiçbir şey gönderilmedi: "{name}" içinde kim var okunamadı ve mesaj her birine ayrı mühürlenir ({err})',
    uk: 'нічого не надіслано: не вдалося дізнатися, хто в "{name}", а повідомлення шифрується кожному з них ({err})',
    'zh-Hans': '什么都没发: 无法读取 "{name}" 里有谁, 而消息要分别加密给每个人 ({err})',
  },
  'group.noRecipients': {
    en: 'nobody in this room could be sealed to',
    ru: 'в этой комнате некому зашифровать сообщение',
    es: 'no hay a quién cifrarle en esta sala',
    pt: 'não há para quem cifrar nesta sala',
    tr: 'bu odada mühürlenecek kimse yok',
    uk: 'у цій кімнаті нема кому зашифрувати повідомлення',
    'zh-Hans': '这个群里没有可加密的对象',
  },

  'join.needsId': {
    en: 'join needs a group id',
    ru: 'join ждёт id группы',
    es: 'join necesita un id de grupo',
    pt: 'join precisa de um id de grupo',
    tr: 'join bir grup id ister',
    uk: 'join чекає id групи',
    'zh-Hans': 'join 需要一个群 id',
  },
  'join.noSuchGroup': {
    en: 'there is no group {gid} on this island',
    ru: 'на этом острове нет группы {gid}',
    es: 'no existe el grupo {gid} en esta isla',
    pt: 'não existe o grupo {gid} nesta ilha',
    tr: 'bu adada {gid} grubu yok',
    uk: 'на цьому острові немає групи {gid}',
    'zh-Hans': '此服务器上没有群 {gid}',
  },
  'join.closed': {
    en: '"{name}" is closed - somebody in it has to add you',
    ru: '"{name}" закрыта, вас должен добавить кто-то из участников',
    es: '"{name}" está cerrada, alguien de adentro tiene que agregarte',
    pt: '"{name}" está fechada, alguém de dentro precisa te adicionar',
    tr: '"{name}" kapalı, içindekilerden biri seni eklemeli',
    uk: '"{name}" закрита, вас має додати хтось із учасників',
    'zh-Hans': '"{name}" 是封闭的, 需要群里的人来加你',
  },
  'join.failed': {
    en: 'could not join: {err}',
    ru: 'не удалось вступить: {err}',
    es: 'no se pudo unir: {err}',
    pt: 'não foi possível entrar: {err}',
    tr: 'katılınamadı: {err}',
    uk: 'не вдалося приєднатися: {err}',
    'zh-Hans': '无法加入: {err}',
  },
  'join.done': {
    en: 'you are in "{name}"',
    ru: 'вы в "{name}"',
    es: 'estás en "{name}"',
    pt: 'você está em "{name}"',
    tr: '"{name}" içindesin',
    uk: 'ви в "{name}"',
    'zh-Hans': '你已加入 "{name}"',
  },

  // Leaving a room, and the other room verbs the CLI now wires in.
  'leave.needsId': {
    en: 'leave needs a group id (or /leave in the room you are in)',
    ru: 'leave ждёт id группы (или /leave в открытой комнате)',
    es: 'leave necesita un id de grupo (o /leave en la sala en la que estás)',
    pt: 'leave precisa de um id de grupo (ou /leave na sala em que você está)',
    tr: 'leave bir grup id ister (ya da içinde olduğun odada /leave)',
    uk: 'leave чекає id групи (або /leave у відкритій кімнаті)',
    'zh-Hans': 'leave 需要一个群 id (或在所在群里用 /leave)',
  },
  'leave.done': {
    en: 'you left "{name}"',
    ru: 'вы вышли из "{name}"',
    es: 'saliste de "{name}"',
    pt: 'você saiu de "{name}"',
    tr: '"{name}" odasından ayrıldın',
    uk: 'ви вийшли з "{name}"',
    'zh-Hans': '你已退出 "{name}"',
  },
  'leave.failed': {
    en: 'could not leave: {err}',
    ru: 'не удалось выйти: {err}',
    es: 'no se pudo salir: {err}',
    pt: 'não foi possível sair: {err}',
    tr: 'ayrılınamadı: {err}',
    uk: 'не вдалося вийти: {err}',
    'zh-Hans': '无法退出: {err}',
  },
  'groups.leaveHint': {
    en: "leave a room with 'rcq leave <id>' (in the conversation: /leave)",
    ru: "выйти из комнаты: 'rcq leave <id>' (в разговоре: /leave)",
    es: "salí de una sala con 'rcq leave <id>' (en la conversación: /leave)",
    pt: "saia de uma sala com 'rcq leave <id>' (na conversa: /leave)",
    tr: "bir odadan 'rcq leave <id>' ile ayrıl (sohbette: /leave)",
    uk: "вийти з кімнати: 'rcq leave <id>' (у розмові: /leave)",
    'zh-Hans': "用 'rcq leave <id>' 退出一个群 (在对话里: /leave)",
  },
  'create.needsName': {
    en: 'create needs a room name in quotes',
    ru: 'create ждёт имя комнаты в кавычках',
    es: 'create necesita un nombre de sala entre comillas',
    pt: 'create precisa de um nome de sala entre aspas',
    tr: 'create tırnak içinde bir oda adı ister',
    uk: 'create чекає назву кімнати в лапках',
    'zh-Hans': 'create 需要带引号的群名称',
  },
  // The id is what every other room command takes (`/g g12`, `/invite g12 396`,
  // `/log g12`), so the one line that announces a new room has to hand it over.
  // Without it the person who just created a room had to go and list rooms to
  // find out what to call it.
  'create.done': {
    en: 'created "{name}" (g{gid})',
    ru: 'создана "{name}" (g{gid})',
    es: 'creada "{name}" (g{gid})',
    pt: 'criada "{name}" (g{gid})',
    tr: '"{name}" oluşturuldu (g{gid})',
    uk: 'створено "{name}" (g{gid})',
    'zh-Hans': '已创建 "{name}" (g{gid})',
  },
  'create.failed': {
    en: 'could not create the room: {err}',
    ru: 'не удалось создать комнату: {err}',
    es: 'no se pudo crear la sala: {err}',
    pt: 'não foi possível criar a sala: {err}',
    tr: 'oda oluşturulamadı: {err}',
    uk: 'не вдалося створити кімнату: {err}',
    'zh-Hans': '无法创建群: {err}',
  },
  'invite.needsArgs': {
    en: 'invite needs a room and a UIN: rcq invite <id> <uin> (or /invite <uin> in the room)',
    ru: 'invite ждёт комнату и UIN: rcq invite <id> <uin> (или /invite <uin> в комнате)',
    es: 'invite necesita una sala y un UIN: rcq invite <id> <uin> (o /invite <uin> en la sala)',
    pt: 'invite precisa de uma sala e um UIN: rcq invite <id> <uin> (ou /invite <uin> na sala)',
    tr: 'invite bir oda ve bir UIN ister: rcq invite <id> <uin> (ya da odada /invite <uin>)',
    uk: 'invite чекає кімнату і UIN: rcq invite <id> <uin> (або /invite <uin> у кімнаті)',
    'zh-Hans': 'invite 需要一个群和一个 UIN: rcq invite <id> <uin> (或在群里用 /invite <uin>)',
  },
  'invite.done': {
    en: '{who} added to "{name}"',
    ru: '{who} добавлен в "{name}"',
    es: '{who} agregado a "{name}"',
    pt: '{who} adicionado a "{name}"',
    tr: '{who} "{name}" odasına eklendi',
    uk: '{who} додано до "{name}"',
    'zh-Hans': '{who} 已加入 "{name}"',
  },
  'invite.failed': {
    en: 'could not add {who}: {err}',
    ru: 'не удалось добавить {who}: {err}',
    es: 'no se pudo agregar a {who}: {err}',
    pt: 'não foi possível adicionar {who}: {err}',
    tr: '{who} eklenemedi: {err}',
    uk: 'не вдалося додати {who}: {err}',
    'zh-Hans': '无法添加 {who}: {err}',
  },

  'log.empty': {
    en: 'nothing in the history file for this',
    ru: 'в файле истории по этому ничего нет',
    es: 'no hay nada en el archivo de historial para esto',
    pt: 'não há nada no arquivo de histórico para isso',
    tr: 'geçmiş dosyasında bununla ilgili bir şey yok',
    uk: 'у файлі історії за цим нічого немає',
    'zh-Hans': '历史文件里没有相关内容',
  },
  'log.badThread': {
    en: "'{what}' is neither a UIN nor a group (g21)",
    ru: "'{what}' это ни UIN, ни группа (g21)",
    es: "'{what}' no es ni un UIN ni un grupo (g21)",
    pt: "'{what}' não é nem um UIN nem um grupo (g21)",
    tr: "'{what}' ne bir UIN ne de bir grup (g21)",
    uk: "'{what}' це ні UIN, ні група (g21)",
    'zh-Hans': "'{what}' 既不是 UIN 也不是群 (g21)",
  },

  // ⚠ This text is the only map of the loop anybody gets, so it lists every
  // verb the loop has and nothing it does not. Sections because a flat block of
  // twenty commands is a wall; the same order as the work: talk, then people,
  // then rooms, then the account. Aliases ride along in parentheses.
  'interactive.help': {
    en: `talking
  /to (t) <uin>        talk to this person (a non-contact is confirmed once, before the first message)
  /g [id|name]         open a room, or list them; its messages then print here
  /recent (rec) [n]    your latest conversations, newest first
  /log (l) [n]         the last n lines of wherever you are (default 20)
  /retry (rt)          send the last message the network refused, again
people
  /who (w) <uin>       who is this number: name, and whether you know them
  /find (f) NAME       search the island for people by name
  /contacts (c)        list contacts
  /add (a) <uin>       send a contact request
  /requests (req, r)   contact requests, both directions
  /accept (ac) <uin>   let them in     /decline (dec) <uin>   turn them down
  /cancel (can) <uin>  withdraw a request you sent
  /block (b) <uin>     stop hearing from them   /unblock (ub) <uin>
  /remove (rm) <uin>   drop a contact on both sides
rooms
  /join (j) <id>       join an open room and walk into it
  /leave (lv) [id]     leave the room you are in, or the one you name
  /create (cr) NAME    make a room
  /invite (inv) <uin>  add somebody to the room you are in
this account
  /whoami (me)         uin, nickname, island, device
  /nick (n) NAME       rename this account
  /export (x)          where the history file is
  /lang (lng) [code]   show or set the language
  /proxy (px)          is your own proxy carrying this session
  /routes (route)      which road to the island is in use
  /help (h)            this text
  /quit (q)            leave (Ctrl+D, or Ctrl+C on an empty line)
Anything else you type goes to whoever the prompt names. Up-arrow walks back
through the commands you have typed; Ctrl+C on a half-typed line drops the line
and keeps the session.`,
    ru: `разговор
  /to (t) <uin>        говорить с этим человеком (не-контакт подтверждается один раз, перед первым сообщением)
  /g [id|имя]          открыть комнату или показать список; её сообщения начнут печататься здесь
  /recent (rec) [n]    последние разговоры, свежие сверху
  /log (l) [n]         последние n строк там, где вы сейчас (по умолчанию 20)
  /retry (rt)          отправить заново то, что сеть не приняла
люди
  /who (w) <uin>       чей это номер: имя и знакомы ли вы
  /find (f) ИМЯ        искать людей на острове по имени
  /contacts (c)        список контактов
  /add (a) <uin>       отправить заявку в контакты
  /requests (req, r)   заявки в контакты, в обе стороны
  /accept (ac) <uin>   принять       /decline (dec) <uin>   отклонить
  /cancel (can) <uin>  отозвать свою заявку
  /block (b) <uin>     перестать получать от них   /unblock (ub) <uin>
  /remove (rm) <uin>   удалить контакт у обоих
комнаты
  /join (j) <id>       вступить в открытую комнату и сразу войти в неё
  /leave (lv) [id]     выйти из открытой комнаты или из той, что вы назвали
  /create (cr) ИМЯ     создать комнату
  /invite (inv) <uin>  добавить человека в открытую комнату
этот аккаунт
  /whoami (me)         uin, ник, остров, устройство
  /nick (n) ИМЯ        переименовать аккаунт
  /export (x)          где лежит файл истории
  /lang (lng) [код]    показать или сменить язык
  /proxy (px)          идёт ли эта сессия через ваш прокси
  /routes (route)      какой дорогой до острова вы сейчас идёте
  /help (h)            этот текст
  /quit (q)            выйти (Ctrl+D или Ctrl+C на пустой строке)
Всё остальное уходит тому, чьё имя в строке ввода. Стрелка вверх листает
набранные команды; Ctrl+C на недописанной строке стирает строку, а не сессию.`,
    es: `hablar
  /to (t) <uin>        hablar con esta persona (un no-contacto se confirma una vez, antes del primer mensaje)
  /g [id|nombre]       abrir una sala, o listarlas; sus mensajes se imprimen acá
  /recent (rec) [n]    tus conversaciones más recientes, la más nueva arriba
  /log (l) [n]         las últimas n líneas de donde estás (por defecto 20)
  /retry (rt)          enviar de nuevo el último mensaje que la red rechazó
gente
  /who (w) <uin>       de quién es este número: nombre y si lo conocés
  /find (f) NOMBRE     buscar personas en la isla por nombre
  /contacts (c)        listar contactos
  /add (a) <uin>       enviar una solicitud de contacto
  /requests (req, r)   solicitudes de contacto, en ambos sentidos
  /accept (ac) <uin>   dejarlo entrar     /decline (dec) <uin>   rechazarlo
  /cancel (can) <uin>  retirar una solicitud que enviaste
  /block (b) <uin>     dejar de recibir de él   /unblock (ub) <uin>
  /remove (rm) <uin>   quitar un contacto de ambos lados
salas
  /join (j) <id>       unirte a una sala abierta y entrar en ella
  /leave (lv) [id]     salir de la sala en la que estás, o de la que nombres
  /create (cr) NOMBRE  crear una sala
  /invite (inv) <uin>  agregar a alguien a la sala en la que estás
esta cuenta
  /whoami (me)         uin, apodo, isla, dispositivo
  /nick (n) NOMBRE     renombrar esta cuenta
  /export (x)          dónde está el archivo de historial
  /lang (lng) [código] mostrar o cambiar el idioma
  /proxy (px)          si esta sesión va por tu propio proxy
  /routes (route)      por qué camino a la isla vas ahora
  /help (h)            este texto
  /quit (q)            salir (Ctrl+D, o Ctrl+C en una línea vacía)
Cualquier otra cosa que escribas va a quien nombre la línea. La flecha arriba
recorre los comandos que escribiste; Ctrl+C en una línea a medias la borra y
mantiene la sesión.`,
    pt: `conversar
  /to (t) <uin>        conversar com esta pessoa (um não-contato é confirmado uma vez, antes da primeira mensagem)
  /g [id|nome]         abrir uma sala, ou listá-las; as mensagens dela aparecem aqui
  /recent (rec) [n]    suas conversas mais recentes, a mais nova em cima
  /log (l) [n]         as últimas n linhas de onde você está (padrão 20)
  /retry (rt)          enviar de novo a última mensagem que a rede recusou
pessoas
  /who (w) <uin>       de quem é este número: nome e se você o conhece
  /find (f) NOME       procurar pessoas na ilha por nome
  /contacts (c)        listar contatos
  /add (a) <uin>       enviar um pedido de contato
  /requests (req, r)   pedidos de contato, nos dois sentidos
  /accept (ac) <uin>   deixá-lo entrar     /decline (dec) <uin>   recusá-lo
  /cancel (can) <uin>  retirar um pedido que você enviou
  /block (b) <uin>     parar de receber dele   /unblock (ub) <uin>
  /remove (rm) <uin>   remover um contato dos dois lados
salas
  /join (j) <id>       entrar em uma sala aberta e ir para ela
  /leave (lv) [id]     sair da sala em que você está, ou da que você nomear
  /create (cr) NOME    criar uma sala
  /invite (inv) <uin>  adicionar alguém à sala em que você está
esta conta
  /whoami (me)         uin, apelido, ilha, dispositivo
  /nick (n) NOME       renomear esta conta
  /export (x)          onde fica o arquivo de histórico
  /lang (lng) [código] mostrar ou trocar o idioma
  /proxy (px)          se esta sessão passa pelo seu proxy
  /routes (route)      por qual caminho até a ilha você está
  /help (h)            este texto
  /quit (q)            sair (Ctrl+D, ou Ctrl+C numa linha vazia)
Qualquer outra coisa que você digitar vai para quem a linha nomear. Seta para
cima percorre os comandos que você digitou; Ctrl+C numa linha pela metade
apaga a linha e mantém a sessão.`,
    tr: `konuşma
  /to (t) <uin>        bu kişiyle konuş (bir kişi olmayan, ilk mesajdan önce bir kez onaylanır)
  /g [id|ad]           bir oda aç ya da listele; mesajları burada yazılır
  /recent (rec) [n]    en son konuşmaların, en yenisi üstte
  /log (l) [n]         bulunduğun yerin son n satırı (varsayılan 20)
  /retry (rt)          ağın kabul etmediği son mesajı yeniden gönder
kişiler
  /who (w) <uin>       bu numara kimin: adı ve onu tanıyıp tanımadığın
  /find (f) AD         adada kişileri ada göre ara
  /contacts (c)        kişileri listele
  /add (a) <uin>       kişi isteği gönder
  /requests (req, r)   kişi istekleri, iki yönde
  /accept (ac) <uin>   içeri al     /decline (dec) <uin>   geri çevir
  /cancel (can) <uin>  gönderdiğin bir isteği geri çek
  /block (b) <uin>     ondan almayı durdur   /unblock (ub) <uin>
  /remove (rm) <uin>   bir kişiyi iki taraftan da sil
odalar
  /join (j) <id>       açık bir odaya katıl ve içine gir
  /leave (lv) [id]     içinde olduğun odadan ya da adını verdiğin odadan ayrıl
  /create (cr) AD      bir oda kur
  /invite (inv) <uin>  içinde olduğun odaya birini ekle
bu hesap
  /whoami (me)         uin, takma ad, ada, cihaz
  /nick (n) AD         bu hesabı yeniden adlandır
  /export (x)          geçmiş dosyası nerede
  /lang (lng) [kod]    dili göster veya ayarla
  /proxy (px)          bu oturum kendi proxynizden mi geçiyor
  /routes (route)      adaya hangi yoldan gidiliyor
  /help (h)            bu metin
  /quit (q)            çık (Ctrl+D ya da boş satırda Ctrl+C)
Yazdığın başka her şey, satırın adını verdiği kişiye gider. Yukarı ok
yazdığın komutlar arasında geri gider; yarım bir satırda Ctrl+C satırı siler,
oturumu değil.`,
    uk: `розмова
  /to (t) <uin>        говорити з цією людиною (не-контакт підтверджується один раз, перед першим повідомленням)
  /g [id|назва]        відкрити кімнату або показати список; її повідомлення почнуть друкуватися тут
  /recent (rec) [n]    останні розмови, свіжі згори
  /log (l) [n]         останні n рядків там, де ви зараз (типово 20)
  /retry (rt)          надіслати заново те, що мережа не прийняла
люди
  /who (w) <uin>       чий це номер: імʼя і чи знайомі ви
  /find (f) ІМʼЯ       шукати людей на острові за іменем
  /contacts (c)        список контактів
  /add (a) <uin>       надіслати запит у контакти
  /requests (req, r)   запити в контакти, в обидва боки
  /accept (ac) <uin>   прийняти       /decline (dec) <uin>   відхилити
  /cancel (can) <uin>  відкликати свій запит
  /block (b) <uin>     перестати отримувати від них   /unblock (ub) <uin>
  /remove (rm) <uin>   видалити контакт у обох
кімнати
  /join (j) <id>       приєднатися до відкритої кімнати і відразу увійти
  /leave (lv) [id]     вийти з відкритої кімнати або з тієї, що ви назвали
  /create (cr) ІМʼЯ    створити кімнату
  /invite (inv) <uin>  додати людину до відкритої кімнати
цей акаунт
  /whoami (me)         uin, нік, острів, пристрій
  /nick (n) ІМʼЯ       перейменувати акаунт
  /export (x)          де лежить файл історії
  /lang (lng) [код]    показати або змінити мову
  /proxy (px)          чи йде ця сесія через ваш проксі
  /routes (route)      якою дорогою до острова ви зараз ідете
  /help (h)            цей текст
  /quit (q)            вийти (Ctrl+D або Ctrl+C на порожньому рядку)
Усе інше йде тому, чиє імʼя в рядку вводу. Стрілка вгору гортає набрані
команди; Ctrl+C на недописаному рядку стирає рядок, а не сесію.`,
    'zh-Hans': `聊天
  /to (t) <uin>        与此人对话 (非联系人在第一条消息前确认一次)
  /g [id|名称]         打开一个群, 或列出全部; 它的消息随后在这里显示
  /recent (rec) [n]    你最近的会话, 最新在上
  /log (l) [n]         你当前所在处的最后 n 行 (默认 20)
  /retry (rt)          重新发送网络刚拒绝的那条消息
联系人
  /who (w) <uin>       这个号码是谁: 名字, 以及你是否认识
  /find (f) 名称       在服务器上按名字找人
  /contacts (c)        列出联系人
  /add (a) <uin>       发送联系人请求
  /requests (req, r)   联系人请求, 双向
  /accept (ac) <uin>   接受     /decline (dec) <uin>   拒绝
  /cancel (can) <uin>  撤回你发出的请求
  /block (b) <uin>     停止接收对方消息   /unblock (ub) <uin>
  /remove (rm) <uin>   双向删除一个联系人
群
  /join (j) <id>       加入一个开放的群并进入它
  /leave (lv) [id]     退出你所在的群, 或你指定的群
  /create (cr) 名称    创建一个群
  /invite (inv) <uin>  把某人加入你所在的群
本账号
  /whoami (me)         uin, 昵称, 服务器, 设备
  /nick (n) 名称       重命名此账号
  /export (x)          历史文件在哪里
  /lang (lng) [代码]   显示或设置语言
  /proxy (px)          这次会话是否走你自己的代理
  /routes (route)      当前走的是哪条通往服务器的路线
  /help (h)            此文本
  /quit (q)            退出 (Ctrl+D, 或在空行按 Ctrl+C)
你输入的其他任何内容都会发给输入行指向的人。上方向键回看你输入过的命令;
在半行输入时按 Ctrl+C 会丢弃该行, 而不是结束会话。`,
  },
  'interactive.hello': {
    en: 'you are #{uin} - /help for commands',
    ru: 'вы #{uin}, команды по /help',
    es: 'sos #{uin}, /help para los comandos',
    pt: 'você é #{uin}, /help para os comandos',
    tr: '#{uin} sensin, komutlar için /help',
    uk: 'ви #{uin}, команди за /help',
    'zh-Hans': '你是 #{uin}, 命令见 /help',
  },
  'interactive.noContacts': {
    en: "(no contacts yet - 'rcq add <uin>' sends a request)",
    ru: "(контактов пока нет, заявку отправит 'rcq add <uin>')",
    es: "(todavía sin contactos, 'rcq add <uin>' envía una solicitud)",
    pt: "(ainda sem contatos, 'rcq add <uin>' envia um pedido)",
    tr: "(henüz kişi yok, 'rcq add <uin>' bir istek gönderir)",
    uk: "(контактів поки немає, запит надішле 'rcq add <uin>')",
    'zh-Hans': "(还没有联系人, 'rcq add <uin>' 发送一条请求)",
  },
  'interactive.replyingTo': {
    en: '(replying to {who} - /to <uin> switches)',
    ru: '(отвечаем {who}, сменить собеседника: /to <uin>)',
    es: '(respondiendo a {who}, /to <uin> cambia)',
    pt: '(respondendo a {who}, /to <uin> troca)',
    tr: '({who} kişisine yanıt veriliyor, /to <uin> değiştirir)',
    uk: '(відповідаємо {who}, змінити співрозмовника: /to <uin>)',
    'zh-Hans': '(正在回复 {who}, /to <uin> 切换)',
  },
  // Somebody you do not know wrote first. The old loop made them the default
  // target of the next line typed, silently.
  'interactive.notPicked': {
    en: '{who} wrote to you - /to {uin} to answer them',
    ru: 'вам написал {who}, ответить: /to {uin}',
    es: '{who} te escribió, /to {uin} para responderle',
    pt: '{who} escreveu para você, /to {uin} para responder',
    tr: '{who} sana yazdı, yanıtlamak için /to {uin}',
    uk: 'вам написав {who}, відповісти: /to {uin}',
    'zh-Hans': '{who} 给你发了消息, /to {uin} 来回复',
  },
  // The tick names the message as well as the peer: two lines to the same
  // person produced two identical notes, and in a busy stream neither of them
  // belonged to anything.
  'interactive.delivered': {
    en: '✓ delivered to {who}: {text}',
    ru: '✓ доставлено {who}: {text}',
    es: '✓ entregado a {who}: {text}',
    pt: '✓ entregue a {who}: {text}',
    tr: '✓ {who} kişisine iletildi: {text}',
    uk: '✓ доставлено {who}: {text}',
    'zh-Hans': '✓ 已送达 {who}: {text}',
  },
  'exit.finishing': {
    en: 'finishing the message that is still going out...',
    ru: 'дописываем сообщение, которое ещё уходит...',
    es: 'terminando el mensaje que todavía está saliendo...',
    pt: 'terminando a mensagem que ainda está saindo...',
    tr: 'hâlâ giden mesaj tamamlanıyor...',
    uk: 'дописуємо повідомлення, яке ще йде...',
    'zh-Hans': '正在完成还在发出的那条消息...',
  },
  'export.at': {
    en: 'history file: {file}',
    ru: 'файл истории: {file}',
    es: 'archivo de historial: {file}',
    pt: 'arquivo de histórico: {file}',
    tr: 'geçmiş dosyası: {file}',
    uk: 'файл історії: {file}',
    'zh-Hans': '历史文件: {file}',
  },
  'recent.none': {
    en: '(no conversations yet - /to <uin> starts one, /find NAME looks somebody up)',
    ru: '(разговоров пока нет: /to <uin> начинает, /find ИМЯ ищет человека)',
    es: '(todavía sin conversaciones: /to <uin> inicia una, /find NOMBRE busca a alguien)',
    pt: '(ainda sem conversas: /to <uin> inicia uma, /find NOME procura alguém)',
    tr: '(henüz konuşma yok: /to <uin> başlatır, /find AD birini arar)',
    uk: '(розмов поки немає: /to <uin> починає, /find ІМʼЯ шукає людину)',
    'zh-Hans': '(还没有会话: /to <uin> 开始一段, /find 名称 查找某人)',
  },
  'recent.you': { en: 'you:', ru: 'вы:', es: 'vos:', pt: 'você:', tr: 'sen:', uk: 'ви:', 'zh-Hans': '你:' },
  'interactive.usageTo': {
    en: 'usage: /to <uin>',
    ru: 'использование: /to <uin>',
    es: 'uso: /to <uin>',
    pt: 'uso: /to <uin>',
    tr: 'kullanım: /to <uin>',
    uk: 'використання: /to <uin>',
    'zh-Hans': '用法: /to <uin>',
  },
  'interactive.usageWho': {
    en: 'usage: /who <uin>',
    ru: 'использование: /who <uin>',
    es: 'uso: /who <uin>',
    pt: 'uso: /who <uin>',
    tr: 'kullanım: /who <uin>',
    uk: 'використання: /who <uin>',
    'zh-Hans': '用法: /who <uin>',
  },
  'interactive.usageNick': {
    en: 'usage: /nick NAME',
    ru: 'использование: /nick ИМЯ',
    es: 'uso: /nick NOMBRE',
    pt: 'uso: /nick NOME',
    tr: 'kullanım: /nick AD',
    uk: 'використання: /nick ІМʼЯ',
    'zh-Hans': '用法: /nick 名称',
  },
  'interactive.usageAdd': {
    en: 'usage: /add <uin>',
    ru: 'использование: /add <uin>',
    es: 'uso: /add <uin>',
    pt: 'uso: /add <uin>',
    tr: 'kullanım: /add <uin>',
    uk: 'використання: /add <uin>',
    'zh-Hans': '用法: /add <uin>',
  },
  'interactive.usageAccept': {
    en: 'usage: /accept <uin>',
    ru: 'использование: /accept <uin>',
    es: 'uso: /accept <uin>',
    pt: 'uso: /accept <uin>',
    tr: 'kullanım: /accept <uin>',
    uk: 'використання: /accept <uin>',
    'zh-Hans': '用法: /accept <uin>',
  },
  'interactive.usageDecline': {
    en: 'usage: /decline <uin>',
    ru: 'использование: /decline <uin>',
    es: 'uso: /decline <uin>',
    pt: 'uso: /decline <uin>',
    tr: 'kullanım: /decline <uin>',
    uk: 'використання: /decline <uin>',
    'zh-Hans': '用法: /decline <uin>',
  },
  'interactive.usageCancel': {
    en: 'usage: /cancel <uin>',
    ru: 'использование: /cancel <uin>',
    es: 'uso: /cancel <uin>',
    pt: 'uso: /cancel <uin>',
    tr: 'kullanım: /cancel <uin>',
    uk: 'використання: /cancel <uin>',
    'zh-Hans': '用法: /cancel <uin>',
  },
  'interactive.usageFind': {
    en: 'usage: /find NAME',
    ru: 'использование: /find ИМЯ',
    es: 'uso: /find NOMBRE',
    pt: 'uso: /find NOME',
    tr: 'kullanım: /find AD',
    uk: 'використання: /find ІМʼЯ',
    'zh-Hans': '用法: /find 名称',
  },
  'interactive.usageBlock': {
    en: 'usage: /block <uin> (and /unblock <uin>)',
    ru: 'использование: /block <uin> (и /unblock <uin>)',
    es: 'uso: /block <uin> (y /unblock <uin>)',
    pt: 'uso: /block <uin> (e /unblock <uin>)',
    tr: 'kullanım: /block <uin> (ve /unblock <uin>)',
    uk: 'використання: /block <uin> (і /unblock <uin>)',
    'zh-Hans': '用法: /block <uin> (以及 /unblock <uin>)',
  },
  'interactive.usageRemove': {
    en: 'usage: /remove <uin>',
    ru: 'использование: /remove <uin>',
    es: 'uso: /remove <uin>',
    pt: 'uso: /remove <uin>',
    tr: 'kullanım: /remove <uin>',
    uk: 'використання: /remove <uin>',
    'zh-Hans': '用法: /remove <uin>',
  },
  'interactive.usageCreate': {
    en: 'usage: /create NAME',
    ru: 'использование: /create ИМЯ',
    es: 'uso: /create NOMBRE',
    pt: 'uso: /create NOME',
    tr: 'kullanım: /create AD',
    uk: 'використання: /create ІМʼЯ',
    'zh-Hans': '用法: /create 名称',
  },
  'interactive.usageInvite': {
    en: 'usage: /invite <uin> (in a room), or /invite g<id> <uin>',
    ru: 'использование: /invite <uin> (в комнате) или /invite g<id> <uin>',
    es: 'uso: /invite <uin> (en una sala), o /invite g<id> <uin>',
    pt: 'uso: /invite <uin> (numa sala), ou /invite g<id> <uin>',
    tr: 'kullanım: /invite <uin> (bir odada) ya da /invite g<id> <uin>',
    uk: 'використання: /invite <uin> (у кімнаті) або /invite g<id> <uin>',
    'zh-Hans': '用法: /invite <uin> (在群里), 或 /invite g<id> <uin>',
  },
  'interactive.noGroups': {
    en: '(no rooms yet - "rcq join <id>" joins an open one)',
    ru: '(комнат пока нет, вступить в открытую: "rcq join <id>")',
    es: '(todavía sin salas, "rcq join <id>" te une a una abierta)',
    pt: '(ainda sem salas, "rcq join <id>" entra numa aberta)',
    tr: '(henüz oda yok, "rcq join <id>" açık birine katılır)',
    uk: '(кімнат поки немає, приєднатися до відкритої: "rcq join <id>")',
    'zh-Hans': '(还没有群, "rcq join <id>" 加入一个开放的群)',
  },
  'interactive.unknownSlash': {
    en: 'unknown command {cmd} - /help lists them',
    ru: 'неизвестная команда {cmd}, список по /help',
    es: 'comando desconocido {cmd}, /help los lista',
    pt: 'comando desconhecido {cmd}, /help lista eles',
    tr: 'bilinmeyen komut {cmd}, /help listeler',
    uk: 'невідома команда {cmd}, список за /help',
    'zh-Hans': '未知命令 {cmd}, /help 列出全部',
  },
  'interactive.insideRcq': {
    en: 'you are already inside rcq - just type the message (or /to <uin> to switch)',
    ru: 'вы уже внутри rcq, просто наберите сообщение (сменить контакт: /to <uin>)',
    es: 'ya estás dentro de rcq, escribí el mensaje sin más (o /to <uin> para cambiar)',
    pt: 'você já está dentro do rcq, é só digitar a mensagem (ou /to <uin> para trocar)',
    tr: 'zaten rcq içindesin, mesajı yazman yeterli (ya da değiştirmek için /to <uin>)',
    uk: 'ви вже всередині rcq, просто наберіть повідомлення (змінити контакт: /to <uin>)',
    'zh-Hans': '你已经在 rcq 里了, 直接输入消息即可 (或 /to <uin> 切换)',
  },
  'interactive.noActive': {
    en: 'no one to send to yet - /to <uin> picks a person, /g a room, /recent lists the threads you have',
    ru: 'пока некому писать: /to <uin> выбирает человека, /g комнату, /recent показывает начатые разговоры',
    es: 'todavía no hay a quién enviar: /to <uin> elige a alguien, /g una sala, /recent lista tus conversaciones',
    pt: 'ainda não há para quem enviar: /to <uin> escolhe alguém, /g uma sala, /recent lista suas conversas',
    tr: 'henüz gönderilecek kimse yok: /to <uin> bir kişi, /g bir oda seçer, /recent konuşmalarını listeler',
    uk: 'поки нема кому писати: /to <uin> вибирає людину, /g кімнату, /recent показує ваші розмови',
    'zh-Hans': '还没有可发送的对象: /to <uin> 选一个人, /g 选一个群, /recent 列出你的会话',
  },

  'update.available': {
    en: 'update: v{from} -> v{to}',
    ru: 'обновление: v{from} -> v{to}',
    es: 'actualización: v{from} -> v{to}',
    pt: 'atualização: v{from} -> v{to}',
    tr: 'güncelleme: v{from} -> v{to}',
    uk: 'оновлення: v{from} -> v{to}',
    'zh-Hans': '更新: v{from} -> v{to}',
  },
  'update.how': {
    en: '(download rcq.tar.gz, unpack over the old install; state and account stay)',
    ru: '(скачайте rcq.tar.gz и распакуйте поверх старой установки; состояние и аккаунт сохранятся)',
    es: '(descargá rcq.tar.gz y descomprimilo sobre la instalación vieja; el estado y la cuenta quedan)',
    pt: '(baixe rcq.tar.gz e descompacte sobre a instalação antiga; estado e conta permanecem)',
    tr: '(rcq.tar.gz indir, eski kurulumun üzerine aç; durum ve hesap kalır)',
    uk: '(завантажте rcq.tar.gz і розпакуйте поверх старої встановки; стан і акаунт збережуться)',
    'zh-Hans': '(下载 rcq.tar.gz, 解压覆盖旧安装; 状态和账号保留)',
  },

  'lock.busy': {
    en: 'another rcq (pid {pid}) is running against {dir} - one at a time',
    ru: 'другой rcq (pid {pid}) уже работает с {dir}, за раз только один',
    es: 'otro rcq (pid {pid}) ya está usando {dir}, uno a la vez',
    pt: 'outro rcq (pid {pid}) já está usando {dir}, um de cada vez',
    tr: 'başka bir rcq (pid {pid}) {dir} ile çalışıyor, aynı anda bir tane',
    uk: 'інший rcq (pid {pid}) уже працює з {dir}, за раз лише один',
    'zh-Hans': '另一个 rcq (pid {pid}) 正在使用 {dir}, 一次只能一个',
  },
} satisfies Record<string, Record<Lang, string>>

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
