// javac is a short-lived JVM, so it gains a lot from startup tuning:
//  - javac.jsa: AppCDS archive of the compiler's own classes, built at image
//    build time (docker/worker/Dockerfile). Missing/invalid archive => the JVM
//    silently runs without it.
//  - C1 only + Serial GC: less JIT/GC warm-up work for a ~1s process.
//  - -Xlog:disable keeps CDS diagnostics out of compiler output.
const JAVAC_JVM = [
  '-J-Xshare:auto',
  '-J-XX:SharedArchiveFile=/usr/local/lib/java/javac.jsa',
  '-J-XX:TieredStopAtLevel=1',
  '-J-XX:+UseSerialGC',
  '-J-Xlog:disable',
].join(' ');

// The user program keeps the full JIT (C2) so CPU-heavy solutions are not slowed
// down; only flags that cut startup cost without affecting peak speed are added.
const JAVA_JVM = '-Xshare:auto -XX:-UsePerfData -Xlog:disable';

export default {
  id: 62,
  name: 'Java (OpenJDK 17)',
  is_archived: false,
  source_file: 'Main.java',
  compile_cmd: `javac ${JAVAC_JVM} -cp .:/usr/local/lib/java/* *.java`,
  run_cmd: `java ${JAVA_JVM} -cp .:/usr/local/lib/java/* Main`,
  image: 'codebox/java:17',
};
