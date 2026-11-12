package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	githubReleaseAPI = "https://api.github.com/repos/xavierfnk/ak-dispatch/releases/latest"
	githubReleaseURL = "https://github.com/xavierfnk/ak-dispatch/releases/download/"
	maxUpdateSize    = 512 << 20
)

// Set to the release tag by the release workflow; local builds identify as v0.1.0.
var appVersion = "v0.1.0"

// shortcut: one pinned release key; rotate it by shipping a transition build that trusts both keys.
var updatePublicKey = ""

var errUpdateAssetPending = errors.New("release asset is not yet available")

type UpdateStatus struct {
	CurrentVersion string
	LatestVersion  string
	Available      bool
	Pending        bool
	Installed      bool
	InstallPath    string
}

type githubRelease struct {
	TagName    string        `json:"tag_name"`
	Prerelease bool          `json:"prerelease"`
	Assets     []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
}

func (s *PlannerService) CheckForUpdate() (UpdateStatus, error) {
	status := UpdateStatus{CurrentVersion: appVersion}
	installPath, installed, err := currentInstallState()
	if err != nil {
		return UpdateStatus{}, errors.New("Could not determine the per-user application install location.")
	}
	status.InstallPath, status.Installed = installPath, installed

	release, err := fetchLatestRelease()
	if err != nil {
		return UpdateStatus{}, err
	}
	if !validVersion(release.TagName) {
		return UpdateStatus{}, errors.New("The latest GitHub release has an invalid version tag.")
	}
	status.LatestVersion = release.TagName
	status.Available = isNewerVersion(release.TagName, appVersion)
	if status.Available {
		if _, err := parseUpdatePublicKey(updatePublicKey); err != nil {
			return UpdateStatus{}, errors.New("This build has no release verification key and cannot install updates.")
		}
		pending, err := updatePending(release, runtime.GOOS, runtime.GOARCH)
		if err != nil {
			return UpdateStatus{}, err
		}
		status.Pending = pending
		status.Available = !pending
	}
	return status, nil
}

func updatePending(release githubRelease, goos, goarch string) (bool, error) {
	asset, err := releaseAsset(release, goos, goarch)
	if err == nil {
		_, err = releaseSignatureAsset(release, asset)
	}
	if errors.Is(err, errUpdateAssetPending) {
		return true, nil
	}
	return false, err
}

func (s *PlannerService) InstallUpdate() error {
	if s.app == nil {
		return errors.New("The application is not ready to install updates.")
	}
	status, err := s.CheckForUpdate()
	if err != nil {
		return err
	}
	if !status.Available {
		return errors.New("The application is already up to date.")
	}
	if !status.Installed {
		return fmt.Errorf("Move the application to %s before updating.", status.InstallPath)
	}
	if err := ensureInstallWritable(status.InstallPath); err != nil {
		return errors.New("The per-user app folder is not writable. Check its permissions and try again.")
	}
	release, err := fetchLatestRelease()
	if err != nil {
		return err
	}
	if !isNewerVersion(release.TagName, appVersion) {
		return errors.New("The application is already up to date.")
	}
	asset, err := releaseAsset(release, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	signatureAsset, err := releaseSignatureAsset(release, asset)
	if err != nil {
		return err
	}
	path, err := downloadUpdate(asset)
	if err != nil {
		return err
	}
	signaturePath, err := downloadUpdate(signatureAsset)
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	if err := verifyUpdateSignature(path, asset.Digest, signaturePath, updatePublicKey); err != nil {
		_ = os.Remove(path)
		_ = os.Remove(signaturePath)
		return errors.New("The downloaded update does not have a valid publisher signature.")
	}
	if err := startPlatformUpdate(path, signaturePath, status.InstallPath, asset.Digest); err != nil {
		_ = os.Remove(path)
		_ = os.Remove(signaturePath)
		return err
	}
	s.app.Quit()
	return nil
}

func fetchLatestRelease() (githubRelease, error) {
	request, err := http.NewRequest(http.MethodGet, githubReleaseAPI, nil)
	if err != nil {
		return githubRelease{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "patient-dispatch-planner/"+appVersion)
	response, err := githubClient(20 * time.Second).Do(request)
	if err != nil {
		return githubRelease{}, fmt.Errorf("Could not contact GitHub for updates: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusNotFound {
			return githubRelease{}, errors.New("No stable GitHub release has been published yet.")
		}
		return githubRelease{}, fmt.Errorf("GitHub returned status %d while checking for updates.", response.StatusCode)
	}
	var release githubRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&release); err != nil {
		return githubRelease{}, errors.New("GitHub returned invalid release information.")
	}
	if release.Prerelease {
		return githubRelease{}, errors.New("The latest GitHub release is a pre-release.")
	}
	return release, nil
}

func githubClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(request *http.Request, _ []*http.Request) error {
			switch request.URL.Hostname() {
			case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
				return nil
			default:
				return errors.New("GitHub redirected the update download to an unexpected host.")
			}
		},
	}
}

func releaseAsset(release githubRelease, goos, goarch string) (githubAsset, error) {
	name := ""
	switch {
	case goos == "linux" && goarch == "amd64":
		name = "patient-dispatch-planner-linux-x64"
	case goos == "windows" && goarch == "amd64":
		name = "patient-dispatch-planner-windows-x64.exe"
	case goos == "darwin" && goarch == "arm64":
		name = "patient-dispatch-planner-macos-arm64.zip"
	default:
		return githubAsset{}, fmt.Errorf("Updates are not published for %s/%s.", goos, goarch)
	}
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		if err := validateReleaseAsset(release.TagName, asset); err != nil {
			return githubAsset{}, err
		}
		return asset, nil
	}
	return githubAsset{}, fmt.Errorf("%w: %s", errUpdateAssetPending, name)
}

func releaseSignatureAsset(release githubRelease, asset githubAsset) (githubAsset, error) {
	name := asset.Name + ".sig"
	for _, candidate := range release.Assets {
		if candidate.Name != name {
			continue
		}
		if candidate.Size != ed25519.SignatureSize {
			return githubAsset{}, errors.New("GitHub release contains an invalid update signature.")
		}
		if err := validateReleaseAsset(release.TagName, candidate); err != nil {
			return githubAsset{}, err
		}
		return candidate, nil
	}
	return githubAsset{}, fmt.Errorf("%w: %s", errUpdateAssetPending, name)
}

func validateReleaseAsset(tag string, asset githubAsset) error {
	parsed, err := url.Parse(asset.BrowserDownloadURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "github.com" ||
		!strings.HasPrefix(parsed.Path, "/xavierfnk/ak-dispatch/releases/download/"+tag+"/") {
		return errors.New("GitHub release contains an unexpected update URL.")
	}
	if asset.Size <= 0 || asset.Size > maxUpdateSize {
		return errors.New("GitHub release contains an invalid update size.")
	}
	if _, err := parseSHA256(asset.Digest); err != nil {
		return errors.New("GitHub release is missing a valid SHA-256 digest for the update.")
	}
	return nil
}

func downloadUpdate(asset githubAsset) (string, error) {
	request, err := http.NewRequest(http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return "", errors.New("Could not create the update download request.")
	}
	request.Header.Set("User-Agent", "patient-dispatch-planner/"+appVersion)
	response, err := githubClient(5 * time.Minute).Do(request)
	if err != nil {
		return "", fmt.Errorf("Could not download the update: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub returned status %d while downloading the update.", response.StatusCode)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", errors.New("Could not find a local directory for the update download.")
	}
	updateDir := filepath.Join(cache, "Patient Dispatch Planner", "updates")
	if err := os.MkdirAll(updateDir, 0700); err != nil {
		return "", errors.New("Could not create a local directory for the update download.")
	}
	temporary, err := os.CreateTemp(updateDir, "update-*")
	if err != nil {
		return "", errors.New("Could not create a temporary update file.")
	}
	path := temporary.Name()
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, maxUpdateSize+1))
	closeErr := temporary.Close()
	if copyErr != nil || closeErr != nil || written > maxUpdateSize || written != asset.Size {
		_ = os.Remove(path)
		return "", errors.New("The update download was incomplete or too large.")
	}
	expected, _ := parseSHA256(asset.Digest)
	if !equalBytes(hash.Sum(nil), expected) {
		_ = os.Remove(path)
		return "", errors.New("The downloaded update failed its SHA-256 integrity check.")
	}
	return path, nil
}

func validVersion(value string) bool {
	_, valid := parseReleaseVersion(value)
	return valid
}

func isNewerVersion(candidate, current string) bool {
	newer, validNewer := parseReleaseVersion(candidate)
	older, validOlder := parseReleaseVersion(current)
	if !validNewer || !validOlder {
		return false
	}
	for index := range newer {
		if newer[index] != older[index] {
			return newer[index] > older[index]
		}
	}
	return false
}

func parseReleaseVersion(value string) ([3]uint64, bool) {
	var parsed [3]uint64
	if !strings.HasPrefix(value, "v") {
		return parsed, false
	}
	parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
	if len(parts) != len(parsed) {
		return parsed, false
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return [3]uint64{}, false
		}
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				return [3]uint64{}, false
			}
		}
		number, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return [3]uint64{}, false
		}
		parsed[index] = number
	}
	return parsed, true
}

func parseSHA256(value string) ([]byte, error) {
	if !strings.HasPrefix(value, "sha256:") || len(value) != len("sha256:")+sha256.Size*2 {
		return nil, errors.New("invalid sha256 digest")
	}
	return hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
}

func verifyFileSHA256(path, digest string) error {
	expected, err := parseSHA256(digest)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > maxUpdateSize {
		return errors.New("invalid update file size")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if !equalBytes(hash.Sum(nil), expected) {
		return errors.New("update file digest mismatch")
	}
	return nil
}

func verifyUpdateSignature(path, digest, signaturePath, encodedPublicKey string) error {
	expected, err := parseSHA256(digest)
	if err != nil {
		return err
	}
	if err := verifyFileSHA256(path, digest); err != nil {
		return err
	}
	publicKey, err := parseUpdatePublicKey(encodedPublicKey)
	if err != nil {
		return err
	}
	signature, err := os.ReadFile(signaturePath)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("invalid update signature")
	}
	if !ed25519.Verify(publicKey, expected, signature) {
		return errors.New("update signature verification failed")
	}
	return nil
}

func parseUpdatePublicKey(encoded string) (ed25519.PublicKey, error) {
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("invalid update public key")
	}
	return ed25519.PublicKey(key), nil
}

func ensureInstallWritable(path string) error {
	if _, err := os.Stat(path); err != nil {
		return err
	}
	probe, err := os.CreateTemp(filepath.Dir(path), ".patient-dispatch-update-check-*")
	if err != nil {
		return err
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	return os.Remove(name)
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}

func copyUpdateFile(source, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Chmod(destination, mode)
}
