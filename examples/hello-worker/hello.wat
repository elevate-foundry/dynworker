;; hello.wat
;; A minimal WASI hello-world worker.
;; Reads JSON from stdin, writes a greeting JSON to stdout.
;;
;; For simplicity this module hard-codes the greeting.
;; Real workers would use a WASI-compatible language (Rust/Go/C/AssemblyScript).

(module
  ;; Import WASI fd_write to write to stdout (fd=1)
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))

  (memory 1)
  (export "memory" (memory 0))

  ;; The greeting string stored at offset 64
  (data (i32.const 64) "{\"greeting\":\"Hello from DynWorker!\",\"runtime\":\"wasmtime\"}\n")

  (func $main (export "_start")
    ;; iovec at offset 0: ptr=64, len=57
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 57))
    ;; nwritten at offset 8
    (drop (call $fd_write
      (i32.const 1)   ;; fd = stdout
      (i32.const 0)   ;; iovec array ptr
      (i32.const 1)   ;; iovec count
      (i32.const 8)   ;; nwritten ptr
    ))
  )
)
