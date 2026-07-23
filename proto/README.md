# Vendored protobuf

`idb.proto` is vendored verbatim from Meta's
[`facebook/idb`](https://github.com/facebook/idb) (`proto/idb.proto`), which is
licensed under the MIT License (see the copyright header in the file). It
defines the `idb.CompanionService` gRPC API that the `companion` backend speaks
to `idb_companion`.

Loaded at runtime by `@grpc/proto-loader`; not compiled. When bumping
`idb_companion`, re-vendor this file if the API changes.
