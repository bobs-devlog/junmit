// libNative.dylib을 메인 앱에 link. 별도 sidecar 프로세스가 아닌 메인 앱과 같은
// 프로세스에서 시스템 API를 호출해야 TCC가 bundle identity로 권한을 귀속시킨다.
// dylib install_name이 @rpath/libNative.dylib이라 dev/release 양쪽 RPATH를 추가한다.
fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let bin_dir = format!("{manifest_dir}/../resources/bin");

    println!("cargo:rustc-link-search=native={bin_dir}");
    println!("cargo:rustc-link-lib=dylib=Native");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{bin_dir}");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources/bin");
    println!("cargo:rerun-if-changed={bin_dir}/libNative.dylib");

    tauri_build::build()
}
