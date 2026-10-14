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
    public function register(): void
    {
        add_action('wp_footer', [$this, 'loader'], 100);
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

        $editor = Session::isEditor();
        $config = [
            'rest' => esc_url_raw(rest_url(Rest::NAMESPACE)),
            'nonce' => is_user_logged_in() ? wp_create_nonce('wp_rest') : '',
            'editor' => $editor,
            'user' => $editor ? wp_get_current_user()->display_name : '',
            'screenshotLibrary' => self::screenshotLibraryUrl(),
        ];
        ?>
        <script id="wprc-loader">
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
        })(<?php echo wp_json_encode($config); ?>);
        </script>
        <?php
    }
}
