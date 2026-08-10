#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(const char *message) {
  fprintf(stderr, "typr-native-sandbox: %s: %s\n", message, strerror(errno));
  exit(126);
}

static int create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static void add_path_rule(int ruleset, const char *path, __u64 access, int optional) {
  int parent = open(path, O_PATH | O_CLOEXEC);
  if (parent < 0) {
    if (optional && errno == ENOENT) return;
    fail(path);
  }
  struct landlock_path_beneath_attr rule = {
    .allowed_access = access,
    .parent_fd = parent
  };
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) {
    close(parent);
    fail("could not add Landlock filesystem rule");
  }
  close(parent);
}

static void set_limit(int resource, rlim_t value) {
  struct rlimit limit = { .rlim_cur = value, .rlim_max = value };
  if (setrlimit(resource, &limit) < 0) fail("could not apply process resource limit");
}

int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") != 0 || argv[1][0] != '/') {
    fprintf(stderr, "usage: typr-native-sandbox /absolute/compile-root -- command [args...]\n");
    return 126;
  }

  char *compile_root = realpath(argv[1], NULL);
  if (!compile_root || strcmp(compile_root, "/") == 0) fail("invalid compile root");

  int abi = create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) fail("Landlock is unavailable; refusing unsandboxed native compilation");

  __u64 read_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
  __u64 execute_access = read_access | LANDLOCK_ACCESS_FS_EXECUTE;
  __u64 write_access = LANDLOCK_ACCESS_FS_WRITE_FILE |
    LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
    LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
    LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
    LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
  if (abi >= 2) write_access |= LANDLOCK_ACCESS_FS_REFER;
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  if (abi >= 3) write_access |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif

  struct landlock_ruleset_attr ruleset_attr = {
    .handled_access_fs = execute_access | write_access
  };
  int ruleset = create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset < 0) fail("could not create Landlock ruleset");

  add_path_rule(ruleset, compile_root, read_access | write_access, 0);
  add_path_rule(ruleset, "/usr", execute_access, 0);
  add_path_rule(ruleset, "/bin", execute_access, 0);
  add_path_rule(ruleset, "/lib", execute_access, 0);
  add_path_rule(ruleset, "/lib64", execute_access, 1);
  add_path_rule(ruleset, "/etc", read_access, 0);
  add_path_rule(ruleset, "/var/lib/texmf", read_access, 1);
  add_path_rule(ruleset, "/var/cache/fontconfig", read_access, 1);
  add_path_rule(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
  add_path_rule(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 0);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("could not set no-new-privileges");
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) < 0) fail("could not enforce Landlock ruleset");
  close(ruleset);

  set_limit(RLIMIT_CORE, 0);
  set_limit(RLIMIT_FSIZE, 64 * 1024 * 1024);
  set_limit(RLIMIT_NOFILE, 256);
  /* RLIMIT_NPROC counts every thread owned by the host UID and is therefore
     unsafe inside a non-user-namespaced container. Deployments use the
     container pids_limit for a real per-container ceiling. */

  execvp(argv[3], &argv[3]);
  fail("could not execute native compiler");
  return 126;
}
