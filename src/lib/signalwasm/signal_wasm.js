let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

function wasm_bindgen__convert__closures_____invoke__h719c467d95b43fa2(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h719c467d95b43fa2(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h95117f985b015cea(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h95117f985b015cea(arg0, arg1, arg2, arg3);
}

const WasmCiphertextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmciphertext_free(ptr >>> 0, 1));

const WasmGroupIdentifierFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmgroupidentifier_free(ptr >>> 0, 1));

const WasmGroupMasterKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmgroupmasterkey_free(ptr >>> 0, 1));

const WasmGroupSecretParamsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmgroupsecretparams_free(ptr >>> 0, 1));

const WasmIdentityKeyPairFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmidentitykeypair_free(ptr >>> 0, 1));

const WasmInMemIdentityKeyStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasminmemidentitykeystore_free(ptr >>> 0, 1));

const WasmInMemKyberPreKeyStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasminmemkyberprekeystore_free(ptr >>> 0, 1));

const WasmInMemPreKeyStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasminmemprekeystore_free(ptr >>> 0, 1));

const WasmInMemSenderKeyStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasminmemsenderkeystore_free(ptr >>> 0, 1));

const WasmInMemSessionStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasminmemsessionstore_free(ptr >>> 0, 1));

const WasmInMemSignedPreKeyStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasminmemsignedprekeystore_free(ptr >>> 0, 1));

const WasmKyberPreKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmkyberprekey_free(ptr >>> 0, 1));

const WasmPreKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmprekey_free(ptr >>> 0, 1));

const WasmPrivateKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmprivatekey_free(ptr >>> 0, 1));

const WasmProtocolAddressFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmprotocoladdress_free(ptr >>> 0, 1));

const WasmPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmpublickey_free(ptr >>> 0, 1));

const WasmSafetyNumberFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmsafetynumber_free(ptr >>> 0, 1));

const WasmSignedPreKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmsignedprekey_free(ptr >>> 0, 1));

export class WasmCiphertext {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmCiphertext.prototype);
        obj.__wbg_ptr = ptr;
        WasmCiphertextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmCiphertextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmciphertext_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get message_type() {
        const ret = wasm.wasmciphertext_message_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array}
     */
    get body() {
        const ret = wasm.wasmciphertext_body(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmCiphertext.prototype[Symbol.dispose] = WasmCiphertext.prototype.free;

export class WasmGroupIdentifier {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmGroupIdentifier.prototype);
        obj.__wbg_ptr = ptr;
        WasmGroupIdentifierFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmGroupIdentifierFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmgroupidentifier_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get serialize() {
        const ret = wasm.wasmgroupidentifier_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmGroupIdentifier.prototype[Symbol.dispose] = WasmGroupIdentifier.prototype.free;

export class WasmGroupMasterKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmGroupMasterKey.prototype);
        obj.__wbg_ptr = ptr;
        WasmGroupMasterKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmGroupMasterKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmgroupmasterkey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {WasmGroupMasterKey}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmgroupmasterkey_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmGroupMasterKey.__wrap(ret[0]);
    }
    /**
     * @returns {WasmGroupIdentifier}
     */
    derive_identifier() {
        const ret = wasm.wasmgroupmasterkey_derive_identifier(this.__wbg_ptr);
        return WasmGroupIdentifier.__wrap(ret);
    }
    /**
     * @returns {WasmGroupSecretParams}
     */
    derive_secret_params() {
        const ret = wasm.wasmgroupmasterkey_derive_secret_params(this.__wbg_ptr);
        return WasmGroupSecretParams.__wrap(ret);
    }
    /**
     * @returns {WasmGroupMasterKey}
     */
    static generate() {
        const ret = wasm.wasmgroupmasterkey_generate();
        return WasmGroupMasterKey.__wrap(ret);
    }
    /**
     * @returns {Uint8Array}
     */
    get serialize() {
        const ret = wasm.wasmgroupmasterkey_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmGroupMasterKey.prototype[Symbol.dispose] = WasmGroupMasterKey.prototype.free;

export class WasmGroupSecretParams {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmGroupSecretParams.prototype);
        obj.__wbg_ptr = ptr;
        WasmGroupSecretParamsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmGroupSecretParamsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmgroupsecretparams_free(ptr, 0);
    }
    /**
     * @returns {WasmGroupIdentifier}
     */
    get_identifier() {
        const ret = wasm.wasmgroupsecretparams_get_identifier(this.__wbg_ptr);
        return WasmGroupIdentifier.__wrap(ret);
    }
    /**
     * @returns {Uint8Array}
     */
    get serialize() {
        const ret = wasm.wasmgroupsecretparams_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmGroupSecretParams.prototype[Symbol.dispose] = WasmGroupSecretParams.prototype.free;

/**
 * IdentityKeyPair — wraps a (PublicKey, PrivateKey) pair used as the long-term identity.
 */
export class WasmIdentityKeyPair {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmIdentityKeyPair.prototype);
        obj.__wbg_ptr = ptr;
        WasmIdentityKeyPairFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmIdentityKeyPairFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmidentitykeypair_free(ptr, 0);
    }
    /**
     * @returns {WasmPublicKey}
     */
    get public_key() {
        const ret = wasm.wasmidentitykeypair_public_key(this.__wbg_ptr);
        return WasmPublicKey.__wrap(ret);
    }
    /**
     * Deserialize from standard protobuf format.
     * @param {Uint8Array} data
     * @returns {WasmIdentityKeyPair}
     */
    static deserialize(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmidentitykeypair_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmIdentityKeyPair.__wrap(ret[0]);
    }
    /**
     * @returns {WasmPrivateKey}
     */
    get private_key() {
        const ret = wasm.wasmidentitykeypair_private_key(this.__wbg_ptr);
        return WasmPrivateKey.__wrap(ret);
    }
    /**
     * @param {WasmPublicKey} public_key
     * @param {WasmPrivateKey} private_key
     */
    constructor(public_key, private_key) {
        _assertClass(public_key, WasmPublicKey);
        _assertClass(private_key, WasmPrivateKey);
        const ret = wasm.wasmidentitykeypair_new(public_key.__wbg_ptr, private_key.__wbg_ptr);
        this.__wbg_ptr = ret >>> 0;
        WasmIdentityKeyPairFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Serialize to the standard protobuf format used by libsignal.
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.wasmidentitykeypair_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmIdentityKeyPair.prototype[Symbol.dispose] = WasmIdentityKeyPair.prototype.free;

export class WasmInMemIdentityKeyStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmInMemIdentityKeyStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasminmemidentitykeystore_free(ptr, 0);
    }
    /**
     * @param {WasmIdentityKeyPair} identity_key_pair
     * @param {number} registration_id
     */
    constructor(identity_key_pair, registration_id) {
        _assertClass(identity_key_pair, WasmIdentityKeyPair);
        const ret = wasm.wasminmemidentitykeystore_new(identity_key_pair.__wbg_ptr, registration_id);
        this.__wbg_ptr = ret >>> 0;
        WasmInMemIdentityKeyStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmInMemIdentityKeyStore.prototype[Symbol.dispose] = WasmInMemIdentityKeyStore.prototype.free;

export class WasmInMemKyberPreKeyStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmInMemKyberPreKeyStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasminmemkyberprekeystore_free(ptr, 0);
    }
    /**
     * @param {number} id
     * @returns {Promise<Uint8Array | undefined>}
     */
    export_kyber_pre_key(id) {
        const ret = wasm.wasminmemkyberprekeystore_export_kyber_pre_key(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * @param {number} id
     * @param {Uint8Array} record_bytes
     * @returns {Promise<void>}
     */
    import_kyber_pre_key(id, record_bytes) {
        const ptr0 = passArray8ToWasm0(record_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasminmemkyberprekeystore_import_kyber_pre_key(this.__wbg_ptr, id, ptr0, len0);
        return ret;
    }
    constructor() {
        const ret = wasm.wasminmemkyberprekeystore_new();
        this.__wbg_ptr = ret >>> 0;
        WasmInMemKyberPreKeyStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmInMemKyberPreKeyStore.prototype[Symbol.dispose] = WasmInMemKyberPreKeyStore.prototype.free;

export class WasmInMemPreKeyStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmInMemPreKeyStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasminmemprekeystore_free(ptr, 0);
    }
    /**
     * @param {number} id
     * @returns {Promise<Uint8Array | undefined>}
     */
    export_pre_key(id) {
        const ret = wasm.wasminmemprekeystore_export_pre_key(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * @param {number} id
     * @param {Uint8Array} record_bytes
     * @returns {Promise<void>}
     */
    import_pre_key(id, record_bytes) {
        const ptr0 = passArray8ToWasm0(record_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasminmemprekeystore_import_pre_key(this.__wbg_ptr, id, ptr0, len0);
        return ret;
    }
    constructor() {
        const ret = wasm.wasminmemprekeystore_new();
        this.__wbg_ptr = ret >>> 0;
        WasmInMemPreKeyStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmInMemPreKeyStore.prototype[Symbol.dispose] = WasmInMemPreKeyStore.prototype.free;

export class WasmInMemSenderKeyStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmInMemSenderKeyStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasminmemsenderkeystore_free(ptr, 0);
    }
    /**
     * @param {WasmProtocolAddress} address
     * @param {string} distribution_id
     * @returns {Promise<Uint8Array | undefined>}
     */
    export_sender_key(address, distribution_id) {
        _assertClass(address, WasmProtocolAddress);
        const ptr0 = passStringToWasm0(distribution_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasminmemsenderkeystore_export_sender_key(this.__wbg_ptr, address.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {WasmProtocolAddress} address
     * @param {string} distribution_id
     * @param {Uint8Array} record_bytes
     * @returns {Promise<void>}
     */
    import_sender_key(address, distribution_id, record_bytes) {
        _assertClass(address, WasmProtocolAddress);
        const ptr0 = passStringToWasm0(distribution_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(record_bytes, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.wasminmemsenderkeystore_import_sender_key(this.__wbg_ptr, address.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    constructor() {
        const ret = wasm.wasminmemsenderkeystore_new();
        this.__wbg_ptr = ret >>> 0;
        WasmInMemSenderKeyStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmInMemSenderKeyStore.prototype[Symbol.dispose] = WasmInMemSenderKeyStore.prototype.free;

export class WasmInMemSessionStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmInMemSessionStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasminmemsessionstore_free(ptr, 0);
    }
    /**
     * @param {WasmProtocolAddress} address
     * @returns {Promise<boolean>}
     */
    has_session(address) {
        _assertClass(address, WasmProtocolAddress);
        const ret = wasm.wasminmemsessionstore_has_session(this.__wbg_ptr, address.__wbg_ptr);
        return ret;
    }
    /**
     * @param {WasmProtocolAddress} address
     * @returns {Promise<Uint8Array | undefined>}
     */
    export_session(address) {
        _assertClass(address, WasmProtocolAddress);
        const ret = wasm.wasminmemsessionstore_export_session(this.__wbg_ptr, address.__wbg_ptr);
        return ret;
    }
    /**
     * @param {WasmProtocolAddress} address
     * @param {Uint8Array} session_bytes
     * @returns {Promise<void>}
     */
    import_session(address, session_bytes) {
        _assertClass(address, WasmProtocolAddress);
        const ptr0 = passArray8ToWasm0(session_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasminmemsessionstore_import_session(this.__wbg_ptr, address.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {WasmProtocolAddress} address
     * @returns {Promise<void>}
     */
    archive_session(address) {
        _assertClass(address, WasmProtocolAddress);
        const ret = wasm.wasminmemsessionstore_archive_session(this.__wbg_ptr, address.__wbg_ptr);
        return ret;
    }
    constructor() {
        const ret = wasm.wasminmemsessionstore_new();
        this.__wbg_ptr = ret >>> 0;
        WasmInMemSessionStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmInMemSessionStore.prototype[Symbol.dispose] = WasmInMemSessionStore.prototype.free;

export class WasmInMemSignedPreKeyStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmInMemSignedPreKeyStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasminmemsignedprekeystore_free(ptr, 0);
    }
    /**
     * @param {number} id
     * @returns {Promise<Uint8Array | undefined>}
     */
    export_signed_pre_key(id) {
        const ret = wasm.wasminmemsignedprekeystore_export_signed_pre_key(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * @param {number} id
     * @param {Uint8Array} record_bytes
     * @returns {Promise<void>}
     */
    import_signed_pre_key(id, record_bytes) {
        const ptr0 = passArray8ToWasm0(record_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasminmemsignedprekeystore_import_signed_pre_key(this.__wbg_ptr, id, ptr0, len0);
        return ret;
    }
    constructor() {
        const ret = wasm.wasminmemsignedprekeystore_new();
        this.__wbg_ptr = ret >>> 0;
        WasmInMemSignedPreKeyStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WasmInMemSignedPreKeyStore.prototype[Symbol.dispose] = WasmInMemSignedPreKeyStore.prototype.free;

export class WasmKyberPreKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmKyberPreKey.prototype);
        obj.__wbg_ptr = ptr;
        WasmKyberPreKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmKyberPreKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmkyberprekey_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get public_key() {
        const ret = wasm.wasmkyberprekey_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get id() {
        const ret = wasm.wasmkyberprekey_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get record() {
        const ret = wasm.wasmkyberprekey_record(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get signature() {
        const ret = wasm.wasmkyberprekey_signature(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {bigint}
     */
    get timestamp() {
        const ret = wasm.wasmkyberprekey_timestamp(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
}
if (Symbol.dispose) WasmKyberPreKey.prototype[Symbol.dispose] = WasmKyberPreKey.prototype.free;

export class WasmPreKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmPreKey.prototype);
        obj.__wbg_ptr = ptr;
        WasmPreKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPreKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmprekey_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get public_key() {
        const ret = wasm.wasmprekey_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get id() {
        const ret = wasm.wasmprekey_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get record() {
        const ret = wasm.wasmprekey_record(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmPreKey.prototype[Symbol.dispose] = WasmPreKey.prototype.free;

/**
 * PrivateKey — standalone asymmetric secret key.
 */
export class WasmPrivateKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmPrivateKey.prototype);
        obj.__wbg_ptr = ptr;
        WasmPrivateKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPrivateKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmprivatekey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} data
     * @returns {WasmPrivateKey}
     */
    static deserialize(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmprivatekey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPrivateKey.__wrap(ret[0]);
    }
    /**
     * @returns {WasmPublicKey}
     */
    getPublicKey() {
        const ret = wasm.wasmprivatekey_getPublicKey(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPublicKey.__wrap(ret[0]);
    }
    /**
     * @returns {WasmPrivateKey}
     */
    static generate() {
        const ret = wasm.wasmprivatekey_generate();
        return WasmPrivateKey.__wrap(ret);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.wasmprivatekey_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmPrivateKey.prototype[Symbol.dispose] = WasmPrivateKey.prototype.free;

export class WasmProtocolAddress {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmProtocolAddressFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmprotocoladdress_free(ptr, 0);
    }
    /**
     * @param {string} name
     * @param {number} device_id
     */
    constructor(name, device_id) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmprotocoladdress_new(ptr0, len0, device_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        WasmProtocolAddressFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {string}
     */
    get name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprotocoladdress_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get deviceId() {
        const ret = wasm.wasmprotocoladdress_deviceId(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmProtocolAddress.prototype[Symbol.dispose] = WasmProtocolAddress.prototype.free;

/**
 * PublicKey — standalone asymmetric public key.
 */
export class WasmPublicKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        WasmPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmpublickey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} data
     * @returns {WasmPublicKey}
     */
    static deserialize(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmpublickey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPublicKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.wasmpublickey_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmPublicKey.prototype[Symbol.dispose] = WasmPublicKey.prototype.free;

export class WasmSafetyNumber {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmSafetyNumber.prototype);
        obj.__wbg_ptr = ptr;
        WasmSafetyNumberFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmSafetyNumberFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmsafetynumber_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get displayable() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmsafetynumber_displayable(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    get scannable() {
        const ret = wasm.wasmsafetynumber_scannable(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) WasmSafetyNumber.prototype[Symbol.dispose] = WasmSafetyNumber.prototype.free;

export class WasmSignedPreKey {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmSignedPreKey.prototype);
        obj.__wbg_ptr = ptr;
        WasmSignedPreKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmSignedPreKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmsignedprekey_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get public_key() {
        const ret = wasm.wasmsignedprekey_public_key(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get id() {
        const ret = wasm.wasmsignedprekey_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    get record() {
        const ret = wasm.wasmsignedprekey_record(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    get signature() {
        const ret = wasm.wasmsignedprekey_signature(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {bigint}
     */
    get timestamp() {
        const ret = wasm.wasmsignedprekey_timestamp(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
}
if (Symbol.dispose) WasmSignedPreKey.prototype[Symbol.dispose] = WasmSignedPreKey.prototype.free;

/**
 * Create a sender key distribution message.
 * @param {WasmProtocolAddress} local_address
 * @param {string} distribution_id
 * @param {WasmInMemSenderKeyStore} sender_key_store
 * @returns {Promise<Uint8Array>}
 */
export function createSenderKeyDistribution(local_address, distribution_id, sender_key_store) {
    _assertClass(local_address, WasmProtocolAddress);
    const ptr0 = passStringToWasm0(distribution_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(sender_key_store, WasmInMemSenderKeyStore);
    const ret = wasm.createSenderKeyDistribution(local_address.__wbg_ptr, ptr0, len0, sender_key_store.__wbg_ptr);
    return ret;
}

/**
 * Decrypt a group message.
 * @param {WasmProtocolAddress} sender_address
 * @param {Uint8Array} ciphertext
 * @param {WasmInMemSenderKeyStore} sender_key_store
 * @returns {Promise<Uint8Array>}
 */
export function decryptGroupMessage(sender_address, ciphertext, sender_key_store) {
    _assertClass(sender_address, WasmProtocolAddress);
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(sender_key_store, WasmInMemSenderKeyStore);
    const ret = wasm.decryptGroupMessage(sender_address.__wbg_ptr, ptr0, len0, sender_key_store.__wbg_ptr);
    return ret;
}

/**
 * Decrypt a Signal message.
 * @param {Uint8Array} ciphertext
 * @param {number} message_type
 * @param {WasmProtocolAddress} sender
 * @param {WasmProtocolAddress} local_address
 * @param {WasmInMemSessionStore} session_store
 * @param {WasmInMemIdentityKeyStore} identity_store
 * @param {WasmInMemPreKeyStore} prekey_store
 * @param {WasmInMemSignedPreKeyStore} signed_prekey_store
 * @param {WasmInMemKyberPreKeyStore} kyber_prekey_store
 * @returns {Promise<Uint8Array>}
 */
export function decryptMessage(ciphertext, message_type, sender, local_address, session_store, identity_store, prekey_store, signed_prekey_store, kyber_prekey_store) {
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(sender, WasmProtocolAddress);
    _assertClass(local_address, WasmProtocolAddress);
    _assertClass(session_store, WasmInMemSessionStore);
    _assertClass(identity_store, WasmInMemIdentityKeyStore);
    _assertClass(prekey_store, WasmInMemPreKeyStore);
    _assertClass(signed_prekey_store, WasmInMemSignedPreKeyStore);
    _assertClass(kyber_prekey_store, WasmInMemKyberPreKeyStore);
    const ret = wasm.decryptMessage(ptr0, len0, message_type, sender.__wbg_ptr, local_address.__wbg_ptr, session_store.__wbg_ptr, identity_store.__wbg_ptr, prekey_store.__wbg_ptr, signed_prekey_store.__wbg_ptr, kyber_prekey_store.__wbg_ptr);
    return ret;
}

/**
 * Encrypt a group message.
 * @param {WasmProtocolAddress} local_address
 * @param {string} distribution_id
 * @param {Uint8Array} plaintext
 * @param {WasmInMemSenderKeyStore} sender_key_store
 * @returns {Promise<Uint8Array>}
 */
export function encryptGroupMessage(local_address, distribution_id, plaintext, sender_key_store) {
    _assertClass(local_address, WasmProtocolAddress);
    const ptr0 = passStringToWasm0(distribution_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    _assertClass(sender_key_store, WasmInMemSenderKeyStore);
    const ret = wasm.encryptGroupMessage(local_address.__wbg_ptr, ptr0, len0, ptr1, len1, sender_key_store.__wbg_ptr);
    return ret;
}

/**
 * Encrypt a Signal message.
 * @param {Uint8Array} plaintext
 * @param {WasmProtocolAddress} recipient
 * @param {WasmProtocolAddress} local_address
 * @param {WasmInMemSessionStore} session_store
 * @param {WasmInMemIdentityKeyStore} identity_store
 * @returns {Promise<WasmCiphertext>}
 */
export function encryptMessage(plaintext, recipient, local_address, session_store, identity_store) {
    const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(recipient, WasmProtocolAddress);
    _assertClass(local_address, WasmProtocolAddress);
    _assertClass(session_store, WasmInMemSessionStore);
    _assertClass(identity_store, WasmInMemIdentityKeyStore);
    const ret = wasm.encryptMessage(ptr0, len0, recipient.__wbg_ptr, local_address.__wbg_ptr, session_store.__wbg_ptr, identity_store.__wbg_ptr);
    return ret;
}

/**
 * Generate a Kyber PreKey for post-quantum security.
 * @param {number} key_id
 * @param {WasmIdentityKeyPair} identity_key_pair
 * @param {WasmInMemKyberPreKeyStore} kyber_prekey_store
 * @returns {Promise<WasmKyberPreKey>}
 */
export function generateKyberPreKey(key_id, identity_key_pair, kyber_prekey_store) {
    _assertClass(identity_key_pair, WasmIdentityKeyPair);
    _assertClass(kyber_prekey_store, WasmInMemKyberPreKeyStore);
    const ret = wasm.generateKyberPreKey(key_id, identity_key_pair.__wbg_ptr, kyber_prekey_store.__wbg_ptr);
    return ret;
}

/**
 * Generate a batch of one-time PreKeys.
 * @param {number} start_id
 * @param {number} count
 * @param {WasmInMemPreKeyStore} prekey_store
 * @returns {Promise<WasmPreKey[]>}
 */
export function generatePreKeys(start_id, count, prekey_store) {
    _assertClass(prekey_store, WasmInMemPreKeyStore);
    const ret = wasm.generatePreKeys(start_id, count, prekey_store.__wbg_ptr);
    return ret;
}

/**
 * Generate a registration ID using unbiased rejection sampling (1..=MAX_REGISTRATION_ID).
 * @returns {number}
 */
export function generateRegistrationId() {
    const ret = wasm.generateRegistrationId();
    return ret >>> 0;
}

/**
 * Generate a safety number.
 * @param {string} local_uuid
 * @param {WasmPublicKey} local_identity_key
 * @param {string} contact_uuid
 * @param {WasmPublicKey} contact_identity_key
 * @returns {WasmSafetyNumber}
 */
export function generateSafetyNumber(local_uuid, local_identity_key, contact_uuid, contact_identity_key) {
    const ptr0 = passStringToWasm0(local_uuid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(local_identity_key, WasmPublicKey);
    const ptr1 = passStringToWasm0(contact_uuid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    _assertClass(contact_identity_key, WasmPublicKey);
    const ret = wasm.generateSafetyNumber(ptr0, len0, local_identity_key.__wbg_ptr, ptr1, len1, contact_identity_key.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return WasmSafetyNumber.__wrap(ret[0]);
}

/**
 * Generate a signed PreKey.
 * @param {number} key_id
 * @param {WasmIdentityKeyPair} identity_key_pair
 * @param {WasmInMemSignedPreKeyStore} signed_prekey_store
 * @returns {Promise<WasmSignedPreKey>}
 */
export function generateSignedPreKey(key_id, identity_key_pair, signed_prekey_store) {
    _assertClass(identity_key_pair, WasmIdentityKeyPair);
    _assertClass(signed_prekey_store, WasmInMemSignedPreKeyStore);
    const ret = wasm.generateSignedPreKey(key_id, identity_key_pair.__wbg_ptr, signed_prekey_store.__wbg_ptr);
    return ret;
}

/**
 * @returns {Uint8Array}
 */
export function generate_attachment_key() {
    const ret = wasm.generate_attachment_key();
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
export function generate_random_bytes(length) {
    const ret = wasm.generate_random_bytes(length);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @returns {Uint8Array}
 */
export function generate_uuid() {
    const ret = wasm.generate_uuid();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

export function init() {
    wasm.init();
}

/**
 * @param {string} message
 */
export function log_to_console(message) {
    const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.log_to_console(ptr0, len0);
}

/**
 * @returns {number}
 */
export function message_type_pre_key() {
    const ret = wasm.message_type_pre_key();
    return ret;
}

/**
 * @returns {number}
 */
export function message_type_sender_key() {
    const ret = wasm.message_type_sender_key();
    return ret;
}

/**
 * @returns {number}
 */
export function message_type_signal() {
    const ret = wasm.message_type_signal();
    return ret;
}

/**
 * Process a PreKeyBundle to establish a session.
 * @param {WasmProtocolAddress} recipient
 * @param {WasmProtocolAddress} local_address
 * @param {number} registration_id
 * @param {WasmPublicKey} identity_key
 * @param {number} signed_prekey_id
 * @param {WasmPublicKey} signed_prekey
 * @param {Uint8Array} signed_prekey_signature
 * @param {number | null | undefined} prekey_id
 * @param {Uint8Array | null | undefined} prekey
 * @param {number} kyber_prekey_id
 * @param {Uint8Array} kyber_prekey
 * @param {Uint8Array} kyber_prekey_signature
 * @param {WasmInMemSessionStore} session_store
 * @param {WasmInMemIdentityKeyStore} identity_store
 * @returns {Promise<void>}
 */
export function processPreKeyBundle(recipient, local_address, registration_id, identity_key, signed_prekey_id, signed_prekey, signed_prekey_signature, prekey_id, prekey, kyber_prekey_id, kyber_prekey, kyber_prekey_signature, session_store, identity_store) {
    _assertClass(recipient, WasmProtocolAddress);
    _assertClass(local_address, WasmProtocolAddress);
    _assertClass(identity_key, WasmPublicKey);
    _assertClass(signed_prekey, WasmPublicKey);
    const ptr0 = passArray8ToWasm0(signed_prekey_signature, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(prekey) ? 0 : passArray8ToWasm0(prekey, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(kyber_prekey, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(kyber_prekey_signature, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    _assertClass(session_store, WasmInMemSessionStore);
    _assertClass(identity_store, WasmInMemIdentityKeyStore);
    const ret = wasm.processPreKeyBundle(recipient.__wbg_ptr, local_address.__wbg_ptr, registration_id, identity_key.__wbg_ptr, signed_prekey_id, signed_prekey.__wbg_ptr, ptr0, len0, isLikeNone(prekey_id) ? 0x100000001 : (prekey_id) >>> 0, ptr1, len1, kyber_prekey_id, ptr2, len2, ptr3, len3, session_store.__wbg_ptr, identity_store.__wbg_ptr);
    return ret;
}

/**
 * Process a sender key distribution message.
 * @param {WasmProtocolAddress} sender_address
 * @param {Uint8Array} distribution_message
 * @param {WasmInMemSenderKeyStore} sender_key_store
 * @returns {Promise<void>}
 */
export function processSenderKeyDistribution(sender_address, distribution_message, sender_key_store) {
    _assertClass(sender_address, WasmProtocolAddress);
    const ptr0 = passArray8ToWasm0(distribution_message, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(sender_key_store, WasmInMemSenderKeyStore);
    const ret = wasm.processSenderKeyDistribution(sender_address.__wbg_ptr, ptr0, len0, sender_key_store.__wbg_ptr);
    return ret;
}

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
export function uuid_from_string(s) {
    const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.uuid_from_string(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uuid_to_string(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.uuid_to_string(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Verify a scanned safety number.
 * @param {Uint8Array} scanned
 * @param {string} local_uuid
 * @param {WasmPublicKey} local_identity_key
 * @param {string} contact_uuid
 * @param {WasmPublicKey} contact_identity_key
 * @returns {boolean}
 */
export function verifySafetyNumber(scanned, local_uuid, local_identity_key, contact_uuid, contact_identity_key) {
    const ptr0 = passArray8ToWasm0(scanned, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(local_uuid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    _assertClass(local_identity_key, WasmPublicKey);
    const ptr2 = passStringToWasm0(contact_uuid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    _assertClass(contact_identity_key, WasmPublicKey);
    const ret = wasm.verifySafetyNumber(ptr0, len0, ptr1, len1, local_identity_key.__wbg_ptr, ptr2, len2, contact_identity_key.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg__wbg_cb_unref_87dfb5aaa0cbcea7 = function(arg0) {
        arg0._wbg_cb_unref();
    };
    imports.wbg.__wbg_call_3020136f7a2d6e44 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_abb4ff46ce38be40 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_1c61fac11405ffdc = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_9b655bdd369112f2 = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_log_1d990106d99dacb7 = function(arg0) {
        console.log(arg0);
    };
    imports.wbg.__wbg_new_ff12d2b041fb48f1 = function(arg0, arg1) {
        try {
            var state0 = {a: arg0, b: arg1};
            var cb0 = (arg0, arg1) => {
                const a = state0.a;
                state0.a = 0;
                try {
                    return wasm_bindgen__convert__closures_____invoke__h95117f985b015cea(a, state0.b, arg0, arg1);
                } finally {
                    state0.a = a;
                }
            };
            const ret = new Promise(cb0);
            return ret;
        } finally {
            state0.a = state0.b = 0;
        }
    };
    imports.wbg.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_now_69d776cd24f5215b = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_9b549dfce8865860 = function(arg0) {
        const ret = arg0.queueMicrotask;
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_fca69f5bfad613a5 = function(arg0) {
        queueMicrotask(arg0);
    };
    imports.wbg.__wbg_resolve_fd5bfbaa4ce36e1e = function(arg0) {
        const ret = Promise.resolve(arg0);
        return ret;
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_then_4f95312d68691235 = function(arg0, arg1) {
        const ret = arg0.then(arg1);
        return ret;
    };
    imports.wbg.__wbg_wasmciphertext_new = function(arg0) {
        const ret = WasmCiphertext.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_wasmkyberprekey_new = function(arg0) {
        const ret = WasmKyberPreKey.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_wasmprekey_new = function(arg0) {
        const ret = WasmPreKey.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_wasmsignedprekey_new = function(arg0) {
        const ret = WasmSignedPreKey.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_5d8eff5a71c6c22c = function(arg0, arg1) {
        // Cast intrinsic for `Closure(Closure { dtor_idx: 163, function: Function { arguments: [Externref], shim_idx: 164, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
        const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__hc57421e3fb8e958c, wasm_bindgen__convert__closures_____invoke__h719c467d95b43fa2);
        return ret;
    };
    imports.wbg.__wbindgen_cast_77bc3e92745e9a35 = function(arg0, arg1) {
        var v0 = getArrayU8FromWasm0(arg0, arg1).slice();
        wasm.__wbindgen_free(arg0, arg1 * 1, 1);
        // Cast intrinsic for `Vector(U8) -> Externref`.
        const ret = v0;
        return ret;
    };
    imports.wbg.__wbindgen_cast_b5a774609d6561f3 = function(arg0, arg1) {
        var v0 = getArrayJsValueFromWasm0(arg0, arg1).slice();
        wasm.__wbindgen_free(arg0, arg1 * 4, 4);
        // Cast intrinsic for `Vector(NamedExternref("WasmPreKey")) -> Externref`.
        const ret = v0;
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('signal_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
