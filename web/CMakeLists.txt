# The web helper, proscenium-web-helper: Chromium through CEF, in its own process.
# The compositor side (src/web.c) is part of the compositor and builds with meson.
#
#   cmake -S web -B build/web -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/web
cmake_minimum_required(VERSION 3.21)
project(proscenium_web LANGUAGES C CXX)

# The pinned distribution scripts/fetch-cef downloads into build/cef.
set(cef_name "cef_binary_154.0.32+g682c378+chromium-154.0.8037.58_linux64_minimal")
get_filename_component(default_cef_root
  "${CMAKE_CURRENT_SOURCE_DIR}/../build/cef/${cef_name}" ABSOLUTE)
set(CEF_ROOT "${default_cef_root}" CACHE PATH "The CEF binary distribution to build against")
if(NOT EXISTS "${CEF_ROOT}/include/cef_app.h")
  message(FATAL_ERROR "CEF_ROOT (${CEF_ROOT}) is not a CEF distribution; "
                      "scripts/fetch-cef downloads the pinned one.")
endif()

set(CMAKE_CXX_STANDARD 20)
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GBM REQUIRED IMPORTED_TARGET gbm libdrm)

add_executable(proscenium-web-helper helper.cpp gpu.cpp)
target_include_directories(proscenium-web-helper PRIVATE "${CEF_ROOT}")
target_compile_definitions(proscenium-web-helper PRIVATE ${CEF_COMPILER_DEFINES})
target_compile_options(proscenium-web-helper PRIVATE
  -O2 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers)
target_link_libraries(proscenium-web-helper
  libcef_dll_wrapper "${CEF_ROOT}/Release/libcef.so" pthread dl EGL GLESv2 PkgConfig::GBM)
set_target_properties(proscenium-web-helper PROPERTIES BUILD_RPATH "$ORIGIN;${CEF_ROOT}/Release")

# Chromium looks for its resources and libraries next to the executable; link
# them in from the distribution rather than copying it.
file(GLOB runtime_files "${CEF_ROOT}/Resources/*" "${CEF_ROOT}/Release/*")
foreach(path IN LISTS runtime_files)
  get_filename_component(name "${path}" NAME)
  file(CREATE_LINK "${path}" "${CMAKE_CURRENT_BINARY_DIR}/${name}" SYMBOLIC)
endforeach()
