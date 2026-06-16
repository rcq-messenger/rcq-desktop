/* tslint:disable */
/* eslint-disable */

export class WasmCiphertext {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly message_type: number;
  readonly body: Uint8Array;
}

export class WasmGroupIdentifier {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly serialize: Uint8Array;
}

export class WasmGroupMasterKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  static from_bytes(bytes: Uint8Array): WasmGroupMasterKey;
  derive_identifier(): WasmGroupIdentifier;
  derive_secret_params(): WasmGroupSecretParams;
  static generate(): WasmGroupMasterKey;
  readonly serialize: Uint8Array;
}

export class WasmGroupSecretParams {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  get_identifier(): WasmGroupIdentifier;
  readonly serialize: Uint8Array;
}

export class WasmIdentityKeyPair {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Deserialize from standard protobuf format.
   */
  static deserialize(data: Uint8Array): WasmIdentityKeyPair;
  constructor(public_key: WasmPublicKey, private_key: WasmPrivateKey);
  /**
   * Serialize to the standard protobuf format used by libsignal.
   */
  serialize(): Uint8Array;
  readonly public_key: WasmPublicKey;
  readonly private_key: WasmPrivateKey;
}

export class WasmInMemIdentityKeyStore {
  free(): void;
  [Symbol.dispose](): void;
  constructor(identity_key_pair: WasmIdentityKeyPair, registration_id: number);
}

export class WasmInMemKyberPreKeyStore {
  free(): void;
  [Symbol.dispose](): void;
  export_kyber_pre_key(id: number): Promise<Uint8Array | undefined>;
  import_kyber_pre_key(id: number, record_bytes: Uint8Array): Promise<void>;
  constructor();
}

export class WasmInMemPreKeyStore {
  free(): void;
  [Symbol.dispose](): void;
  export_pre_key(id: number): Promise<Uint8Array | undefined>;
  import_pre_key(id: number, record_bytes: Uint8Array): Promise<void>;
  constructor();
}

export class WasmInMemSenderKeyStore {
  free(): void;
  [Symbol.dispose](): void;
  export_sender_key(address: WasmProtocolAddress, distribution_id: string): Promise<Uint8Array | undefined>;
  import_sender_key(address: WasmProtocolAddress, distribution_id: string, record_bytes: Uint8Array): Promise<void>;
  constructor();
}

export class WasmInMemSessionStore {
  free(): void;
  [Symbol.dispose](): void;
  has_session(address: WasmProtocolAddress): Promise<boolean>;
  export_session(address: WasmProtocolAddress): Promise<Uint8Array | undefined>;
  import_session(address: WasmProtocolAddress, session_bytes: Uint8Array): Promise<void>;
  archive_session(address: WasmProtocolAddress): Promise<void>;
  constructor();
}

export class WasmInMemSignedPreKeyStore {
  free(): void;
  [Symbol.dispose](): void;
  export_signed_pre_key(id: number): Promise<Uint8Array | undefined>;
  import_signed_pre_key(id: number, record_bytes: Uint8Array): Promise<void>;
  constructor();
}

export class WasmKyberPreKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly public_key: Uint8Array;
  readonly id: number;
  readonly record: Uint8Array;
  readonly signature: Uint8Array;
  readonly timestamp: bigint;
}

export class WasmPreKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly public_key: Uint8Array;
  readonly id: number;
  readonly record: Uint8Array;
}

export class WasmPrivateKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(data: Uint8Array): WasmPrivateKey;
  getPublicKey(): WasmPublicKey;
  static generate(): WasmPrivateKey;
  serialize(): Uint8Array;
}

export class WasmProtocolAddress {
  free(): void;
  [Symbol.dispose](): void;
  constructor(name: string, device_id: number);
  readonly name: string;
  readonly deviceId: number;
}

export class WasmPublicKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(data: Uint8Array): WasmPublicKey;
  serialize(): Uint8Array;
}

export class WasmSafetyNumber {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly displayable: string;
  readonly scannable: Uint8Array;
}

export class WasmSignedPreKey {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly public_key: Uint8Array;
  readonly id: number;
  readonly record: Uint8Array;
  readonly signature: Uint8Array;
  readonly timestamp: bigint;
}

/**
 * Create a sender key distribution message.
 */
export function createSenderKeyDistribution(local_address: WasmProtocolAddress, distribution_id: string, sender_key_store: WasmInMemSenderKeyStore): Promise<Uint8Array>;

/**
 * Decrypt a group message.
 */
export function decryptGroupMessage(sender_address: WasmProtocolAddress, ciphertext: Uint8Array, sender_key_store: WasmInMemSenderKeyStore): Promise<Uint8Array>;

/**
 * Decrypt a Signal message.
 */
export function decryptMessage(ciphertext: Uint8Array, message_type: number, sender: WasmProtocolAddress, local_address: WasmProtocolAddress, session_store: WasmInMemSessionStore, identity_store: WasmInMemIdentityKeyStore, prekey_store: WasmInMemPreKeyStore, signed_prekey_store: WasmInMemSignedPreKeyStore, kyber_prekey_store: WasmInMemKyberPreKeyStore): Promise<Uint8Array>;

/**
 * Encrypt a group message.
 */
export function encryptGroupMessage(local_address: WasmProtocolAddress, distribution_id: string, plaintext: Uint8Array, sender_key_store: WasmInMemSenderKeyStore): Promise<Uint8Array>;

/**
 * Encrypt a Signal message.
 */
export function encryptMessage(plaintext: Uint8Array, recipient: WasmProtocolAddress, local_address: WasmProtocolAddress, session_store: WasmInMemSessionStore, identity_store: WasmInMemIdentityKeyStore): Promise<WasmCiphertext>;

/**
 * Generate a Kyber PreKey for post-quantum security.
 */
export function generateKyberPreKey(key_id: number, identity_key_pair: WasmIdentityKeyPair, kyber_prekey_store: WasmInMemKyberPreKeyStore): Promise<WasmKyberPreKey>;

/**
 * Generate a batch of one-time PreKeys.
 */
export function generatePreKeys(start_id: number, count: number, prekey_store: WasmInMemPreKeyStore): Promise<WasmPreKey[]>;

/**
 * Generate a registration ID using unbiased rejection sampling (1..=MAX_REGISTRATION_ID).
 */
export function generateRegistrationId(): number;

/**
 * Generate a safety number.
 */
export function generateSafetyNumber(local_uuid: string, local_identity_key: WasmPublicKey, contact_uuid: string, contact_identity_key: WasmPublicKey): WasmSafetyNumber;

/**
 * Generate a signed PreKey.
 */
export function generateSignedPreKey(key_id: number, identity_key_pair: WasmIdentityKeyPair, signed_prekey_store: WasmInMemSignedPreKeyStore): Promise<WasmSignedPreKey>;

export function generate_attachment_key(): Uint8Array;

export function generate_random_bytes(length: number): Uint8Array;

export function generate_uuid(): Uint8Array;

export function init(): void;

export function log_to_console(message: string): void;

export function message_type_pre_key(): number;

export function message_type_sender_key(): number;

export function message_type_signal(): number;

/**
 * Process a PreKeyBundle to establish a session.
 */
export function processPreKeyBundle(recipient: WasmProtocolAddress, local_address: WasmProtocolAddress, registration_id: number, identity_key: WasmPublicKey, signed_prekey_id: number, signed_prekey: WasmPublicKey, signed_prekey_signature: Uint8Array, prekey_id: number | null | undefined, prekey: Uint8Array | null | undefined, kyber_prekey_id: number, kyber_prekey: Uint8Array, kyber_prekey_signature: Uint8Array, session_store: WasmInMemSessionStore, identity_store: WasmInMemIdentityKeyStore): Promise<void>;

/**
 * Process a sender key distribution message.
 */
export function processSenderKeyDistribution(sender_address: WasmProtocolAddress, distribution_message: Uint8Array, sender_key_store: WasmInMemSenderKeyStore): Promise<void>;

export function uuid_from_string(s: string): Uint8Array;

export function uuid_to_string(bytes: Uint8Array): string;

/**
 * Verify a scanned safety number.
 */
export function verifySafetyNumber(scanned: Uint8Array, local_uuid: string, local_identity_key: WasmPublicKey, contact_uuid: string, contact_identity_key: WasmPublicKey): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmciphertext_free: (a: number, b: number) => void;
  readonly __wbg_wasmgroupidentifier_free: (a: number, b: number) => void;
  readonly __wbg_wasmgroupmasterkey_free: (a: number, b: number) => void;
  readonly __wbg_wasmgroupsecretparams_free: (a: number, b: number) => void;
  readonly __wbg_wasmidentitykeypair_free: (a: number, b: number) => void;
  readonly __wbg_wasminmemidentitykeystore_free: (a: number, b: number) => void;
  readonly __wbg_wasminmemkyberprekeystore_free: (a: number, b: number) => void;
  readonly __wbg_wasminmemprekeystore_free: (a: number, b: number) => void;
  readonly __wbg_wasminmemsenderkeystore_free: (a: number, b: number) => void;
  readonly __wbg_wasminmemsessionstore_free: (a: number, b: number) => void;
  readonly __wbg_wasminmemsignedprekeystore_free: (a: number, b: number) => void;
  readonly __wbg_wasmkyberprekey_free: (a: number, b: number) => void;
  readonly __wbg_wasmprekey_free: (a: number, b: number) => void;
  readonly __wbg_wasmprivatekey_free: (a: number, b: number) => void;
  readonly __wbg_wasmprotocoladdress_free: (a: number, b: number) => void;
  readonly __wbg_wasmpublickey_free: (a: number, b: number) => void;
  readonly __wbg_wasmsafetynumber_free: (a: number, b: number) => void;
  readonly __wbg_wasmsignedprekey_free: (a: number, b: number) => void;
  readonly createSenderKeyDistribution: (a: number, b: number, c: number, d: number) => any;
  readonly decryptGroupMessage: (a: number, b: number, c: number, d: number) => any;
  readonly decryptMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => any;
  readonly encryptGroupMessage: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly encryptMessage: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly generateKyberPreKey: (a: number, b: number, c: number) => any;
  readonly generatePreKeys: (a: number, b: number, c: number) => any;
  readonly generateRegistrationId: () => number;
  readonly generateSafetyNumber: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
  readonly generateSignedPreKey: (a: number, b: number, c: number) => any;
  readonly generate_attachment_key: () => [number, number, number, number];
  readonly generate_random_bytes: (a: number) => [number, number, number, number];
  readonly generate_uuid: () => [number, number];
  readonly init: () => void;
  readonly log_to_console: (a: number, b: number) => void;
  readonly message_type_pre_key: () => number;
  readonly message_type_sender_key: () => number;
  readonly message_type_signal: () => number;
  readonly processPreKeyBundle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => any;
  readonly processSenderKeyDistribution: (a: number, b: number, c: number, d: number) => any;
  readonly uuid_from_string: (a: number, b: number) => [number, number, number, number];
  readonly uuid_to_string: (a: number, b: number) => [number, number, number, number];
  readonly verifySafetyNumber: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
  readonly wasmciphertext_body: (a: number) => [number, number];
  readonly wasmciphertext_message_type: (a: number) => number;
  readonly wasmgroupidentifier_serialize: (a: number) => [number, number];
  readonly wasmgroupmasterkey_derive_identifier: (a: number) => number;
  readonly wasmgroupmasterkey_derive_secret_params: (a: number) => number;
  readonly wasmgroupmasterkey_from_bytes: (a: number, b: number) => [number, number, number];
  readonly wasmgroupmasterkey_generate: () => number;
  readonly wasmgroupmasterkey_serialize: (a: number) => [number, number];
  readonly wasmgroupsecretparams_get_identifier: (a: number) => number;
  readonly wasmgroupsecretparams_serialize: (a: number) => [number, number];
  readonly wasmidentitykeypair_deserialize: (a: number, b: number) => [number, number, number];
  readonly wasmidentitykeypair_new: (a: number, b: number) => number;
  readonly wasmidentitykeypair_private_key: (a: number) => number;
  readonly wasmidentitykeypair_public_key: (a: number) => number;
  readonly wasmidentitykeypair_serialize: (a: number) => [number, number];
  readonly wasminmemidentitykeystore_new: (a: number, b: number) => number;
  readonly wasminmemkyberprekeystore_export_kyber_pre_key: (a: number, b: number) => any;
  readonly wasminmemkyberprekeystore_import_kyber_pre_key: (a: number, b: number, c: number, d: number) => any;
  readonly wasminmemkyberprekeystore_new: () => number;
  readonly wasminmemprekeystore_export_pre_key: (a: number, b: number) => any;
  readonly wasminmemprekeystore_import_pre_key: (a: number, b: number, c: number, d: number) => any;
  readonly wasminmemprekeystore_new: () => number;
  readonly wasminmemsenderkeystore_export_sender_key: (a: number, b: number, c: number, d: number) => any;
  readonly wasminmemsenderkeystore_import_sender_key: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly wasminmemsenderkeystore_new: () => number;
  readonly wasminmemsessionstore_archive_session: (a: number, b: number) => any;
  readonly wasminmemsessionstore_export_session: (a: number, b: number) => any;
  readonly wasminmemsessionstore_has_session: (a: number, b: number) => any;
  readonly wasminmemsessionstore_import_session: (a: number, b: number, c: number, d: number) => any;
  readonly wasminmemsessionstore_new: () => number;
  readonly wasminmemsignedprekeystore_export_signed_pre_key: (a: number, b: number) => any;
  readonly wasminmemsignedprekeystore_import_signed_pre_key: (a: number, b: number, c: number, d: number) => any;
  readonly wasminmemsignedprekeystore_new: () => number;
  readonly wasmkyberprekey_id: (a: number) => number;
  readonly wasmkyberprekey_public_key: (a: number) => [number, number];
  readonly wasmkyberprekey_record: (a: number) => [number, number];
  readonly wasmkyberprekey_signature: (a: number) => [number, number];
  readonly wasmkyberprekey_timestamp: (a: number) => bigint;
  readonly wasmprekey_id: (a: number) => number;
  readonly wasmprekey_public_key: (a: number) => [number, number];
  readonly wasmprekey_record: (a: number) => [number, number];
  readonly wasmprivatekey_deserialize: (a: number, b: number) => [number, number, number];
  readonly wasmprivatekey_generate: () => number;
  readonly wasmprivatekey_getPublicKey: (a: number) => [number, number, number];
  readonly wasmprivatekey_serialize: (a: number) => [number, number];
  readonly wasmprotocoladdress_deviceId: (a: number) => number;
  readonly wasmprotocoladdress_name: (a: number) => [number, number];
  readonly wasmprotocoladdress_new: (a: number, b: number, c: number) => [number, number, number];
  readonly wasmpublickey_deserialize: (a: number, b: number) => [number, number, number];
  readonly wasmpublickey_serialize: (a: number) => [number, number];
  readonly wasmsafetynumber_displayable: (a: number) => [number, number];
  readonly wasmsafetynumber_scannable: (a: number) => [number, number];
  readonly wasmsignedprekey_id: (a: number) => number;
  readonly wasmsignedprekey_public_key: (a: number) => [number, number];
  readonly wasmsignedprekey_record: (a: number) => [number, number];
  readonly wasmsignedprekey_signature: (a: number) => [number, number];
  readonly wasmsignedprekey_timestamp: (a: number) => bigint;
  readonly wasm_bindgen__convert__closures_____invoke__h719c467d95b43fa2: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen__closure__destroy__hc57421e3fb8e958c: (a: number, b: number) => void;
  readonly wasm_bindgen__convert__closures_____invoke__h95117f985b015cea: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
