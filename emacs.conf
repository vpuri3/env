;(put 'set-goal-column 'disabled nil)
(add-to-list 'auto-mode-alist '("\\.usr\\'" . fortran-mode))
(add-to-list 'auto-mode-alist '("\\.h\\'"   . c++-mode    ))

(autoload 'octave-mode "octave-mod" nil t)
(setq auto-mode-alist
      (cons '("\\.m$" . octave-mode) auto-mode-alist))

(set-face-foreground 'font-lock-comment-face "red")

(global-set-key [24 C-backspace] ; C-x C-backspace
                (lambda () (interactive)
                  (save-excursion
                    (backward-word)
                    (kill-word 1)
                    (yank))))

(global-unset-key (kbd "C-h"))
(global-unset-key (kbd "C-j"))
(global-set-key "\C-h" (lambda () (interactive) (forward-line -10) (scroll-down 10)) )
(global-set-key "\C-j" (lambda () (interactive) (forward-line  10) (scroll-up   10)) )

(global-set-key "\t" 'indent-for-tab-command)
