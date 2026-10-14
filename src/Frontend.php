<?php

namespace GeneroWP\ReviewComments;

/**
 * A tiny loader on every page. Pages are usually served from a page cache, so
 * it decides in the browser whether to load the overlay: for a review link
 * (?review=), an active guest session (flag cookie), a comment link
 * (#wprc-<id>), an ongoing walkthrough, or an editor (logged-in pages bypass
 * the cache).
 *
 * The overlay's URL comes from the uncached /boot endpoint rather than the
 * page, so a page cached before a plugin update still loads the new overlay.
 */
class Frontend implements Module
{
    /** Decides in the browser whether to load the overlay; see the class comment. */
    private const LOADER = <<<'JS'
(function (c) {
    var walking = false;
    try { walking = !!sessionStorage.getItem('wprc_walkthrough'); } catch (e) {}
    var on = c.editor || walking || /[?&]review=/.test(location.search) || /(^|; )wprc_on=1/.test(document.cookie) || /^#wprc-\d+$/.test(location.hash);
    if (!on) return;
    window.wprcConfig = c;
    var headers = c.nonce ? { 'X-WP-Nonce': c.nonce } : {};
    fetch(c.rest + '/boot?url=' + encodeURIComponent(location.pathname + location.search) + '&_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', headers: headers })
        .then(function (r) { return r.json(); })
        .then(function (boot) {
            if (!boot.script) return;
            window.wprcBoot = boot;
            var s = document.createElement('script');
            s.src = boot.script;
            s.defer = true;
            document.body.appendChild(s);
        })
        .catch(function (e) { console.warn('[wprc]', e); });
})
JS;

    public const REVIEW_MODE_META = 'wprc_review_mode';

    public function register(): void
    {
        add_action('wp_footer', [$this, 'loader'], 100);
        add_action('admin_bar_menu', [$this, 'adminBar'], 90);
        add_action('admin_post_wprc_review_mode', [$this, 'toggleReviewMode']);
    }

    /**
     * Whether the review buttons show for this editor on every page. Off by
     * default on production, so a live site looks normal to its editors;
     * review links and comment links work either way.
     */
    public static function reviewModeOn(): bool
    {
        if (! Session::isEditor()) {
            return false;
        }
        $choice = get_user_meta(get_current_user_id(), self::REVIEW_MODE_META, true);
        if ($choice === 'on' || $choice === 'off') {
            return $choice === 'on';
        }

        return wp_get_environment_type() !== 'production';
    }

    public function adminBar(\WP_Admin_Bar $bar): void
    {
        if (is_admin() || ! Session::isEditor()) {
            return;
        }
        $on = self::reviewModeOn();
        $bar->add_node([
            'id' => 'wprc-review-mode',
            'title' => $on ? __('Review mode: on', 'wp-review-comments') : __('Review mode: off', 'wp-review-comments'),
            'href' => wp_nonce_url(add_query_arg(['action' => 'wprc_review_mode', 'mode' => $on ? 'off' : 'on', 'back' => rawurlencode(home_url(add_query_arg([])))], admin_url('admin-post.php')), 'wprc_review_mode'),
            'meta' => ['title' => __('Show or hide the review comment buttons on the site', 'wp-review-comments')],
        ]);
    }

    public function toggleReviewMode(): void
    {
        check_admin_referer('wprc_review_mode');
        if (! Session::isEditor()) {
            wp_die('', 403);
        }
        update_user_meta(get_current_user_id(), self::REVIEW_MODE_META, ($_GET['mode'] ?? '') === 'on' ? 'on' : 'off');
        wp_safe_redirect(wp_validate_redirect(rawurldecode((string) wp_unslash($_GET['back'] ?? '')), home_url('/')));
        exit;
    }

    public static function scriptUrl(): string
    {
        return plugins_url('assets/overlay.js', WP_REVIEW_COMMENTS_FILE).'?ver='.WP_REVIEW_COMMENTS_VERSION;
    }

    public static function screenshotLibraryUrl(): string
    {
        return plugins_url('assets/vendor/html2canvas-pro.min.js', WP_REVIEW_COMMENTS_FILE).'?ver=2.4.5';
    }

    public function loader(): void
    {
        if (is_admin() || wp_doing_ajax() || is_feed() || is_embed()) {
            return;
        }

        $editor = self::reviewModeOn();
        $config = [
            'rest' => esc_url_raw(rest_url(Rest::NAMESPACE)),
            'nonce' => is_user_logged_in() ? wp_create_nonce('wp_rest') : '',
            'editor' => $editor,
            'user' => $editor ? wp_get_current_user()->display_name : '',
            'screenshotLibrary' => self::screenshotLibraryUrl(),
        ];
        // Printed through WordPress so Content Security Policy setups add
        // their nonce; the scripts it loads inherit trust ('strict-dynamic').
        wp_print_inline_script_tag(self::LOADER.'('.wp_json_encode($config).');', ['id' => 'wprc-loader']);
    }
}
