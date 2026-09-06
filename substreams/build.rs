fn main() {
    // ABI JSON is the highest-quality decoding source available here — both
    // files are produced by `forge inspect` from the compiled contracts, not
    // transcribed by hand.
    substreams_ethereum::Abigen::new("Aqua", "abi/aqua.json")
        .expect("failed to load the Aqua ABI")
        .generate()
        .expect("failed to generate Aqua bindings")
        .write_to_file("src/abi/aqua.rs")
        .expect("failed to write Aqua bindings");

    substreams_ethereum::Abigen::new("ZyroRouter", "abi/zyro_router.json")
        .expect("failed to load the ZyroRouter ABI")
        .generate()
        .expect("failed to generate ZyroRouter bindings")
        .write_to_file("src/abi/zyro_router.rs")
        .expect("failed to write ZyroRouter bindings");

    prost_build::compile_protos(&["proto/zyro.proto", "proto/entity.proto"], &["proto/"]).unwrap();
}
