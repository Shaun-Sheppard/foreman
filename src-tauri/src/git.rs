//! Git access goes through the `git` CLI, the most reliable interface for worktrees.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Local and `origin` branch names, de-duplicated and sorted.
    pub branches: Vec<String>,
    pub current: Option<String>,
}

/// Stops Windows flashing a console window for every child process.
pub fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    hide_window(&mut command);
    let out = command
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("Couldn't run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Checks that `path` is a git working tree and lists the branches work can start from.
pub fn inspect(path: &str) -> Result<RepoInfo, String> {
    let repo = Path::new(path);
    if !repo.is_absolute() {
        return Err("Use a full path to the repository folder".into());
    }
    if !repo.is_dir() {
        return Err("That folder doesn't exist".into());
    }
    if git(repo, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Ok("true") {
        return Err("That folder isn't a git repository".into());
    }
    let refs = git(repo, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"])?;
    let mut branches: Vec<String> = refs
        .lines()
        .filter_map(|r| r.strip_prefix("refs/heads/").or_else(|| r.strip_prefix("refs/remotes/origin/")))
        .filter(|b| *b != "HEAD")
        .map(str::to_string)
        .collect();
    branches.sort();
    branches.dedup();
    let current = git(repo, &["branch", "--show-current"]).ok().filter(|b| !b.is_empty());
    Ok(RepoInfo { branches, current })
}

/// `foreman/{id}-{slug-of-title}`, at most six words of slug.
pub fn branch_name(work_item_id: u64, title: &str) -> String {
    let slug: Vec<String> = title
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(6)
        .map(str::to_string)
        .collect();
    if slug.is_empty() {
        format!("foreman/{work_item_id}")
    } else {
        format!("foreman/{work_item_id}-{}", slug.join("-"))
    }
}

/// Default worktree location: `{repo}/../.foreman-worktrees/{workItemId}`.
pub fn worktree_path(repo: &str, root: &str, work_item_id: u64) -> std::path::PathBuf {
    let base = if root.is_empty() {
        Path::new(repo).parent().unwrap_or(Path::new(repo)).join(".foreman-worktrees")
    } else {
        Path::new(root).to_path_buf()
    };
    base.join(work_item_id.to_string())
}

fn ref_exists(repo: &Path, name: &str) -> bool {
    git(repo, &["show-ref", "--verify", "--quiet", name]).is_ok()
}

/// Creates the session's worktree and branch from `base`. Safe to retry: an existing
/// worktree or branch is reused rather than recreated (NFR2).
pub fn ensure_worktree(repo: &str, worktree: &Path, branch: &str, base: &str) -> Result<(), String> {
    let repo = Path::new(repo);
    if worktree.is_dir() && git(worktree, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Ok("true") {
        return Ok(());
    }
    if let Some(parent) = worktree.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the worktree folder: {e}"))?;
    }
    let path = worktree.to_string_lossy();
    let _ = git(repo, &["worktree", "prune"]);
    if ref_exists(repo, &format!("refs/heads/{branch}")) {
        git(repo, &["worktree", "add", &path, branch]).map_err(|e| format!("Couldn't create the worktree: {e}"))?;
        return Ok(());
    }
    // Start from the freshest copy of the base branch we can get.
    let _ = git(repo, &["fetch", "--quiet", "origin", base]);
    let start = if ref_exists(repo, &format!("refs/remotes/origin/{base}")) {
        format!("origin/{base}")
    } else if ref_exists(repo, &format!("refs/heads/{base}")) {
        base.to_string()
    } else {
        return Err(format!("Branch \"{base}\" doesn't exist in this repository"));
    };
    git(repo, &["worktree", "add", "--no-track", "-b", branch, &path, &start])
        .map_err(|e| format!("Couldn't create the worktree: {e}"))?;
    Ok(())
}

/// After a merge: remove the session's worktree and its local branch (FR6.2). A worktree
/// with uncommitted changes is left alone and reported rather than forced away.
pub fn remove_worktree(repo: &str, worktree: &Path, branch: &str) -> Result<(), String> {
    let repo = Path::new(repo);
    if worktree.is_dir() {
        git(repo, &["worktree", "remove", &worktree.to_string_lossy()])
            .map_err(|e| format!("Kept the worktree because it couldn't be removed cleanly: {e}"))?;
    }
    let _ = git(repo, &["worktree", "prune"]);
    if ref_exists(repo, &format!("refs/heads/{branch}")) {
        // -D: a squash merge leaves the branch looking unmerged to git.
        git(repo, &["branch", "-D", branch]).map_err(|e| format!("Couldn't delete the local branch: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_missing_and_non_repo_paths() {
        assert!(inspect("some/relative/path").is_err());
        assert!(inspect("/definitely/not/a/real/folder").is_err());
        let tmp = std::env::temp_dir();
        assert_eq!(inspect(tmp.to_str().unwrap()).unwrap_err(), "That folder isn't a git repository");
    }

    #[test]
    fn branch_names_are_slugged() {
        assert_eq!(branch_name(4512, "Add NHS number validation to patient intake form!"), "foreman/4512-add-nhs-number-validation-to-patient");
        assert_eq!(branch_name(7, "***"), "foreman/7");
    }

    #[test]
    fn worktree_path_defaults_beside_the_repo() {
        assert_eq!(worktree_path("/code/app", "", 42), Path::new("/code/.foreman-worktrees/42"));
        assert_eq!(worktree_path("/code/app", "/wt", 42), Path::new("/wt/42"));
    }

    #[test]
    fn ensure_worktree_is_idempotent_and_checks_the_base() {
        let root = std::env::temp_dir().join(format!("foreman-wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| git(&repo, args).unwrap();
        run(&["init", "-q", "-b", "dev"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        run(&["branch", "releases/1.33"]);
        let repo_str = repo.to_str().unwrap();
        let wt = worktree_path(repo_str, "", 9);

        assert!(ensure_worktree(repo_str, &wt, "foreman/9-x", "nope").is_err());
        ensure_worktree(repo_str, &wt, "foreman/9-x", "releases/1.33").unwrap();
        ensure_worktree(repo_str, &wt, "foreman/9-x", "releases/1.33").unwrap();
        assert_eq!(git(&wt, &["branch", "--show-current"]).unwrap(), "foreman/9-x");

        // Clean-up refuses a dirty worktree, then removes a clean one along with its branch.
        std::fs::write(wt.join("scratch.txt"), "x").unwrap();
        assert!(remove_worktree(repo_str, &wt, "foreman/9-x").is_err());
        assert!(wt.is_dir());
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        remove_worktree(repo_str, &wt, "foreman/9-x").unwrap();
        assert!(!wt.exists());
        assert!(!ref_exists(&repo, "refs/heads/foreman/9-x"));
        remove_worktree(repo_str, &wt, "foreman/9-x").unwrap();
        ensure_worktree(repo_str, &wt, "foreman/9-x", "releases/1.33").unwrap();

        // The folder was deleted but the branch survived: the retry reuses the branch.
        std::fs::remove_dir_all(&wt).unwrap();
        ensure_worktree(repo_str, &wt, "foreman/9-x", "dev").unwrap();
        assert_eq!(git(&wt, &["branch", "--show-current"]).unwrap(), "foreman/9-x");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_local_and_origin_branches_once() {
        let dir = std::env::temp_dir().join(format!("foreman-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| git(&dir, args).unwrap();
        run(&["init", "-q", "-b", "dev"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        run(&["branch", "releases/1.33"]);
        run(&["update-ref", "refs/remotes/origin/dev", "HEAD"]);
        run(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        let info = inspect(dir.to_str().unwrap()).unwrap();
        assert_eq!(info.branches, vec!["dev", "main", "releases/1.33"]);
        assert_eq!(info.current.as_deref(), Some("dev"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
