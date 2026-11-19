export default {
  id: 54,
  name: 'C++ (GCC 9.4.0)',
  is_archived: false,
  source_file: 'main.cpp',
  // /usr/local/include/pch holds a precompiled <bits/stdc++.h> built with these
  // exact flags (see docker/worker/Dockerfile). GCC picks it up automatically
  // when it is the first include and silently falls back to the normal header
  // otherwise (different flags via compiler_options, other first include, ...).
  compile_cmd: 'g++ -O2 -std=c++17 -pipe -I/usr/local/include/pch -I/usr/local/include -o main *.cpp',
  run_cmd: './main',
  image: 'codebox/gcc:9',
  // nlohmann/json.hpp needs ~512MB to compile
  min_memory: 512000,
};
